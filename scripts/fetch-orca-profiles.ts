#!/usr/bin/env -S npx tsx
/**
 * Fetches real printer/filament/quality profiles from OrcaSlicer's own
 * bundled profile tree (github.com/OrcaSlicer/OrcaSlicer/resources/profiles),
 * resolves each profile's `inherits` chain, and writes the result to
 * src/data/orca-profiles.json for src/lib/profiles.ts to consume.
 *
 * Replaces the hand-typed approximate values previously in PRINTER_PRESETS/
 * FILAMENT_PRESETS with real numbers, parsed through the same
 * parseOrcaProfileJson() used for user-imported .3mf/profile files.
 *
 * Run: npx tsx scripts/fetch-orca-profiles.ts
 */
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { parseOrcaProfileJson } from '../src/lib/profiles'
import type { OrcaConfig } from '../src/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_BASE = 'https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/main/resources/profiles'

async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const url = `${RAW_BASE}/${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json() as Promise<Record<string, unknown>>
}

/**
 * Resolve a profile's `inherits` chain within one vendor+category directory
 * (OrcaSlicer profiles only ever inherit siblings in the same dir — verified
 * against the actual profile tree, e.g. Voron/machine/*.json inherits chain
 * to Voron/machine/fdm_klipper_common.json, never cross-vendor). Returns a
 * flat object: root ancestor's fields first, each descendant overriding.
 */
async function resolveInherits(
  vendor: string,
  category: 'machine' | 'process' | 'filament',
  name: string,
  cache: Map<string, Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const cacheKey = `${vendor}/${category}/${name}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  const raw = await fetchJson(`${vendor}/${category}/${name}.json`)
  let merged: Record<string, unknown> = {}
  const parentName = raw['inherits'] as string | undefined
  if (parentName) {
    const parent = await resolveInherits(vendor, category, parentName, cache)
    merged = { ...parent }
  }
  merged = { ...merged, ...raw }
  cache.set(cacheKey, merged)
  return merged
}

interface PrinterSpec {
  label: string
  vendor: string
  machine: string
}

// One real machine profile per printer (bed size / nozzle / height / shape).
// Same 5 printers the previous hand-typed PRINTER_PRESETS covered, so the
// UI's printer list is unchanged — only the underlying numbers are now real
// instead of approximated. Filenames confirmed against BBL.json/Creality.json/
// Prusa.json/Voron.json's machine_list (e.g. "X1C" is filed under its full
// name "Bambu Lab X1 Carbon", not the abbreviation used everywhere else).
const PRINTERS: PrinterSpec[] = [
  { label: 'Bambu Lab P1S', vendor: 'BBL', machine: 'Bambu Lab P1S 0.4 nozzle' },
  { label: 'Bambu Lab X1C', vendor: 'BBL', machine: 'Bambu Lab X1 Carbon 0.4 nozzle' },
  { label: 'Creality Ender 3', vendor: 'Creality', machine: 'Creality Ender-3 0.4 nozzle' },
  { label: 'Prusa MK4', vendor: 'Prusa', machine: 'Prusa MK4 0.4 nozzle' },
  { label: 'Voron 2.4', vendor: 'Voron', machine: 'Voron 2.4 300 0.4 nozzle' },
]

// Draft/Standard/Fine quality tiers: sourced from Bambu X1C's process
// profiles (clean, well-populated tier naming), applied uniformly across
// printers — matches the existing UX where quality preset and printer are
// independent selections, just backed by real numbers now instead of
// hand-typed ones.
const QUALITY_TIERS: { name: string; label: string; description: string; process: string }[] = [
  { name: 'draft', label: 'Draft', description: 'Fast print, lower quality', process: '0.24mm Draft @BBL X1C' },
  { name: 'standard', label: 'Standard', description: 'Balanced quality and speed', process: '0.20mm Standard @BBL X1C' },
  { name: 'fine', label: 'Fine', description: 'High quality, slower print', process: '0.12mm Fine @BBL X1C' },
]

// Generic filaments: BBL ships the most complete generic filament set.
const FILAMENTS: { name: string; vendor: string; filament: string }[] = [
  { name: 'PLA', vendor: 'BBL', filament: 'Generic PLA' },
  { name: 'PETG', vendor: 'BBL', filament: 'Generic PETG' },
  { name: 'ABS', vendor: 'BBL', filament: 'Generic ABS' },
  { name: 'TPU', vendor: 'BBL', filament: 'Generic TPU' },
]

// parseOrcaProfileJson() forwards every unmapped field (start/end G-code,
// per-axis jerk/acceleration curves, multi-extruder offsets, etc.) as
// _passthrough so a user-imported profile can drive settings the UI doesn't
// model. For these *bundled* profiles that's actively harmful, not just
// bloat: real machine_start_gcode/machine_end_gcode use OrcaSlicer's
// PlaceholderParser syntax ({if filament_type==...}, [nozzle_temperature],
// custom G-code macros like M1002/M971/M980.3) which our bridge's plain
// DynamicPrintConfig::set_deserialize_strict() doesn't evaluate — it would
// either no-op or inject literal unresolved placeholder text into the
// G-code. Keep only the fields explicitly modeled in OrcaConfig.
function stripPassthrough(config: Partial<OrcaConfig>): Partial<OrcaConfig> {
  const { _passthrough, ...rest } = config
  void _passthrough
  return rest
}

async function main() {
  const cache = new Map<string, Record<string, unknown>>()

  console.log('Fetching printer machine + process profiles…')
  const printerPresets: Record<string, Partial<OrcaConfig>> = {}
  for (const p of PRINTERS) {
    console.log(`  ${p.label}: ${p.vendor}/machine/${p.machine}`)
    const machineFlat = await resolveInherits(p.vendor, 'machine', p.machine, cache)
    const machineConfig = stripPassthrough(parseOrcaProfileJson(JSON.stringify(machineFlat)))
    printerPresets[p.label] = { printer_model: p.label, ...machineConfig }
  }

  console.log('\nFetching quality tier process profiles (Bambu X1C)…')
  const qualityPresets: { name: string; label: string; description: string; config: Partial<OrcaConfig> }[] = []
  for (const q of QUALITY_TIERS) {
    console.log(`  ${q.label}: BBL/process/${q.process}`)
    const processFlat = await resolveInherits('BBL', 'process', q.process, cache)
    const processConfig = stripPassthrough(parseOrcaProfileJson(JSON.stringify(processFlat)))
    // use_relative_e_distances deliberately excluded — the bridge forces it
    // off by default (orc_init) since our headless build ships no layer_gcode
    // with G92 E0; letting a real profile re-enable it here would silently
    // reintroduce the "every slice fails validation" bug that fix addressed.
    delete (processConfig as Record<string, unknown>).use_relative_e_distances
    qualityPresets.push({ name: q.name, label: q.label, description: q.description, config: processConfig })
  }

  console.log('\nFetching filament profiles…')
  const filamentPresets: Record<string, Partial<OrcaConfig>> = {}
  for (const f of FILAMENTS) {
    console.log(`  ${f.name}: ${f.vendor}/filament/${f.filament}`)
    const flat = await resolveInherits(f.vendor, 'filament', f.filament, cache)
    filamentPresets[f.name] = stripPassthrough(parseOrcaProfileJson(JSON.stringify(flat)))
  }

  const out = { printerPresets, qualityPresets, filamentPresets }
  const outPath = join(__dirname, '../src/data/orca-profiles.json')
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`\nWrote ${outPath}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
