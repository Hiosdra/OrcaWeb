#!/usr/bin/env node
/**
 * WASM engine smoke test.
 *
 * Loads the built slicer.js/slicer.wasm and runs several real orc_init +
 * orc_slice(_multi)/orc_write_3mf/orc_read_3mf calls end-to-end, so a broken
 * engine build is caught before it's ever published as a GitHub Release
 * (build-wasm.yml) or trusted by local `npm run dev` after `npm run setup`.
 *
 * This formalizes the ad-hoc reproduction script referenced (but never
 * committed) in orca-wasm/wasm/CMakeLists.txt's --profiling-funcs comment,
 * which was used to root-cause the Voron Cube wall-generator crash — a
 * build that compiles fine can still trap on a real slice, and nobody
 * noticed until a live user's browser session failed.
 *
 * Usage:
 *   node orca-wasm/scripts/smoke-test.mjs [--wasm-dir public/wasm] [--engine slicer] [--fixture path/to.stl]
 *
 * --engine selects the output-name stem (see orca-wasm/wasm/CMakeLists.txt's
 * ORCA_WEB_WASM_OUTPUT_NAME) — "slicer" (default, single-threaded) or
 * "slicer-mt" (build-wasm.yml's mt matrix leg, real oneTBB — see
 * ADR-011). The mt build never produces a plain
 * slicer.js/.wasm alias, so this must be passed explicitly for that variant.
 *
 * Without --fixture, every scenario runs against TWO meshes:
 *   1. A synthetic torture-test mesh (a subdivided icosphere, ~5120
 *      triangles), generated in memory — no redistribution question, runs
 *      fully offline, adds zero repo bloat.
 *   2. The real Voron Design Cube v7 (e2e/fixtures/voron-design-cube-v7.stl,
 *      vendored under GPL-3.0 — see NOTICE.md and ADR-010). This is the
 *      exact real-world mesh that has repeatedly found bugs a synthetic
 *      primitive never would (the Arachne wall-generator crash chain in
 *      apply.py's patches 8/8c/8d/8e/8f, and the Boost.Log default-sink
 *      hang/trap — see the "disable Boost.Log core" fix in
 *      orca-wasm/bridge/slicer.cpp). Skipped with a warning if the fixture
 *      file isn't present (e.g. running this script outside the repo).
 * Pass --fixture to replace both of the above with a single specific STL,
 * for a closer repro of one particular case (that STL is never committed
 * by this script either).
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  sphereStl, loadModule, writeBytes, decodeError,
  initSession, sliceOnce, sliceMultiOnce, checkedMalloc, free,
} from './lib/engine-harness.mjs'

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wasmDir: 'public/wasm', engine: 'slicer', fixture: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wasm-dir') args.wasmDir = argv[++i]
    else if (argv[i] === '--engine') args.engine = argv[++i]
    else if (argv[i] === '--fixture') args.fixture = argv[++i]
  }
  return args
}

// ── synthetic torture-test mesh (subdivided icosphere) ───────────────────────
// sphereStl() (and its icosphere/trianglesToStl building blocks) live in
// ./lib/engine-harness.mjs.

function generateTortureStl() {
  return sphereStl(4, 10) // 20 * 4^4 = 5120 triangles, 10mm-radius sphere
}

// ── engine harness ──────────────────────────────────────────────────────────
// loadModule() + the orc_* heap marshaling (writeBytes/decodeError/
// initSession/sliceOnce/sliceMultiOnce) live in ./lib/engine-harness.mjs.

function write3mfOnce(module, session, stlBytes) {
  const stlPtr = writeBytes(module, stlBytes)
  try {
    const outPtrPtr = checkedMalloc(module, 4, '3MF output pointer')
    try {
      const outLenPtr = checkedMalloc(module, 4, '3MF output length')
      try {
        const rc = module._orc_write_3mf(session, stlPtr, stlBytes.length, outPtrPtr, outLenPtr)
        if (rc !== 0) throw new Error(`orc_write_3mf failed (${rc}): ${decodeError(module, session)}`)
        const dataPtr = module.getValue(outPtrPtr, 'i32')
        const dataLen = module.getValue(outLenPtr, 'i32')
        try { return module.HEAPU8.slice(dataPtr, dataPtr + dataLen) } finally { module._orc_free(dataPtr) }
      } finally { module._free(outLenPtr) }
    } finally { module._free(outPtrPtr) }
  } finally { free(module, stlPtr) }
}

function read3mfOnce(module, mfBytes) {
  const mfPtr = writeBytes(module, mfBytes)
  try {
    const outStlPtrPtr = checkedMalloc(module, 4, 'STL output pointer')
    try {
      const outStlLenPtr = checkedMalloc(module, 4, 'STL output length')
      try {
        const outConfigPtrPtr = checkedMalloc(module, 4, 'config output pointer')
        try {
          const outConfigLenPtr = checkedMalloc(module, 4, 'config output length')
          try {
            const rc = module._orc_read_3mf(mfPtr, mfBytes.length, outStlPtrPtr, outStlLenPtr, outConfigPtrPtr, outConfigLenPtr)
            if (rc !== 0) throw new Error(`orc_read_3mf failed (${rc}): ${decodeError(module, 0)}`)
            const stlPtr = module.getValue(outStlPtrPtr, 'i32'), stlLen = module.getValue(outStlLenPtr, 'i32')
            const configPtr = module.getValue(outConfigPtrPtr, 'i32'), configLen = module.getValue(outConfigLenPtr, 'i32')
            try { return { stl: module.HEAPU8.slice(stlPtr, stlPtr + stlLen), configJson: module.UTF8ToString(configPtr, configLen) } } finally { module._orc_free(stlPtr); module._orc_free(configPtr) }
          } finally { module._free(outConfigLenPtr) }
        } finally { module._free(outConfigPtrPtr) }
      } finally { module._free(outStlLenPtr) }
    } finally { module._free(outStlPtrPtr) }
  } finally { free(module, mfPtr) }
}

// Binary STL: 80-byte header + uint32 triangle count + N * 50 bytes.
function stlTriangleCount(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
}

// Minimal ZIP central-directory reader — deliberately hand-rolled rather than
// pulling in a zip library (e.g. fflate, used for this in src/lib/*.ts): this
// script also runs inside build-wasm.yml's "Smoke test WASM module" step,
// which only sets up Node (actions/setup-node) and never runs `npm install`
// — so no package outside Node's stdlib is resolvable there. Only reads
// filenames from the central directory (no decompression needed for this
// check), and assumes the classic (non-Zip64) EOCD/CD record layout, which is
// what miniz (OrcaSlicer's zip writer) emits for archives this small — Zip64
// records only get written once entry count or size actually exceeds the
// 32-bit fields' range.
function findEndOfCentralDirectory(bytes) {
  const minPos = Math.max(0, bytes.length - 22 - 65535) // EOCD (22B) + max comment (64KB)
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i
    }
  }
  return -1
}

function listZipEntryNames(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) throw new Error('no End Of Central Directory record found')
  const totalEntries = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)

  const names = []
  let pos = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    const sig = dv.getUint32(pos, true)
    if (sig !== 0x02014b50) throw new Error(`bad central directory entry signature at offset ${pos}`)
    const nameLen = dv.getUint16(pos + 28, true)
    const extraLen = dv.getUint16(pos + 30, true)
    const commentLen = dv.getUint16(pos + 32, true)
    const nameStart = pos + 46
    names.push(new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameStart + nameLen)))
    pos = nameStart + nameLen + extraLen + commentLen
  }
  return names
}

// A .3mf is a ZIP; verify it round-trips as one and carries the two pieces
// orc_write_3mf's contract promises: the mesh (3D/3dmodel.model) and the
// embedded OrcaSlicer settings (a Metadata/*.config file — see
// EMBEDDED_PRINT_FILE_FORMAT et al. in bbs_3mf.hpp for why the filename
// isn't a fixed constant).
function assertValid3mf(bytes, label) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`${label}: output does not start with a ZIP (PK) signature`)
  }
  let names
  try {
    names = listZipEntryNames(bytes)
  } catch (err) {
    throw new Error(`${label}: failed to read ZIP central directory: ${err.message}`)
  }
  if (!names.includes('3D/3dmodel.model')) {
    throw new Error(`${label}: missing 3D/3dmodel.model (entries: ${names.join(', ')})`)
  }
  if (!names.some((n) => /^Metadata\/.*\.config$/.test(n))) {
    throw new Error(`${label}: missing a Metadata/*.config file (entries: ${names.join(', ')})`)
  }
}

// ── sanity assertions on the resulting G-code ─────────────────────────────────

function assertSaneGcode(gcode, label) {
  if (!gcode || gcode.length < 200) throw new Error(`${label}: G-code suspiciously short/empty (${gcode?.length ?? 0} bytes)`)
  if (!/^G1 |\nG1 /.test(gcode)) throw new Error(`${label}: no G1 extrusion moves found`)
  const lines = gcode.split('\n').length
  if (lines < 50) throw new Error(`${label}: only ${lines} lines — expected a real multi-layer slice`)
}

// Regression guard for the bug fixed by center_object_xy_only() in
// slicer.cpp: center_around_origin() used to center the mesh on Z too,
// leaving the object floating with its vertical midpoint (not its base) at
// the bed plane. The torture mesh's base sits at z=0 (see icosphere()
// above), so a correctly-placed slice's lowest G0/G1 Z move should land at
// the first layer height, never deep below zero (sunk into the bed) or
// far above it (floating).
function assertRestsOnBed(gcode, label, firstLayerHeight) {
  const zValues = []
  for (const line of gcode.split('\n')) {
    if (!/^G[01] /.test(line)) continue
    const m = line.match(/Z(-?[0-9.]+)/)
    if (m) zValues.push(parseFloat(m[1]))
  }
  if (zValues.length === 0) throw new Error(`${label}: no Z-bearing G0/G1 moves found`)
  const minZ = Math.min(...zValues)
  if (minZ < -0.01) throw new Error(`${label}: minimum Z is ${minZ} — model appears to be sunk below the bed`)
  if (minZ > firstLayerHeight + 0.05) throw new Error(`${label}: minimum Z is ${minZ}, expected ~${firstLayerHeight} — model appears to be floating above the bed`)
}

// Adaptive (variable) layer height (#138) must actually vary the layer
// thickness — a fixed-height slice emits one repeated ;Z: step (plus at most a
// thin top-cap remainder), an adaptive one emits many. Parse the engine's own
// ;Z:<height> layer-change markers (the authoritative per-layer Z, unlike a raw
// G1 Z scan which also picks up the start-gcode nozzle lift and travel Z-hops)
// and require several distinct steps. The >=3 threshold cleanly separates a
// fixed slice (<=2 distinct: the nominal height + maybe the remainder) from an
// adaptive one (both smoke meshes yield well over a dozen).
function assertVariableLayerHeights(gcode, label) {
  const zs = []
  for (const line of gcode.split('\n')) {
    const m = /^;Z:(-?[0-9.]+)/.exec(line)
    if (m) zs.push(parseFloat(m[1]))
  }
  if (zs.length < 5) throw new Error(`${label}: only ${zs.length} ;Z: layer markers — expected a real multi-layer slice`)
  const steps = new Set()
  for (let i = 1; i < zs.length; i++) steps.add((zs[i] - zs[i - 1]).toFixed(3))
  if (steps.size < 3) {
    throw new Error(`${label}: ${steps.size} distinct layer height(s) — adaptive layer height did not vary the thickness`)
  }
}

// ── real base config (Generic-ish printer + PLA + Standard) ───────────────────
// Deliberately not importing src/lib/profiles.ts (TS + depends on the bundled
// orca-profiles.json shape); a minimal but real, representative config is
// enough to exercise the engine the same way the app's default preset does.

const BASE_CONFIG = {
  bed_size_x: 256,
  bed_size_y: 256,
  printable_height: 250,
  nozzle_diameter: 0.4,
  layer_height: 0.2,
  initial_layer_height: 0.2,
  wall_loops: 2,
  top_shell_layers: 3,
  bottom_shell_layers: 3,
  sparse_infill_density: 15,
  sparse_infill_pattern: 'grid',
  filament_type: 'PLA',
  nozzle_temperature: 220,
  bed_temperature: 55,
}

// A real dual-nozzle machine (Bambu Lab H2D shape) with two filament slots,
// one per nozzle — the exact config shape withFilamentSlots() in
// src/lib/profiles.ts builds, written out here rather than imported for the
// same reason BASE_CONFIG is (see above).
//
// This is the scenario issue #140 was about, and it is worth a committed
// regression test for two independent reasons:
//
//  - Every multi-value option below has to survive serialization with the
//    separator its *type* requires. The bridge used to join all of them with
//    ',', which fused each per-nozzle printable area and colour into one
//    entry — leaving nozzle_diameter length 2 with length-1 companions,
//    indexed by extruder id, and dying in Brim.cpp. A plain "did it slice?"
//    check catches that, since it crashed rather than misbehaved quietly.
//  - The per-filament vectors must all agree in length, or the engine reads
//    past the end of one. flush_volumes_matrix in particular is one N×N
//    sub-matrix per nozzle laid end to end, which append_full_config()
//    validates against flush_multiplier's length.
const DUAL_NOZZLE_CONFIG = {
  ...BASE_CONFIG,
  nozzle_diameter: ['0.4', '0.4'],
  extruder_printable_area: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320'],
  filament_type: ['PLA', 'PETG'],
  filament_colour: ['#F5A623', '#4A90D9'],
  filament_diameter: ['1.75', '1.75'],
  nozzle_temperature: ['220', '255'],
  nozzle_temperature_initial_layer: ['220', '255'],
  hot_plate_temp: ['55', '70'],
  hot_plate_temp_initial_layer: ['55', '70'],
  filament_start_gcode: ['', ''],
  filament_end_gcode: ['', ''],
  // slot 1 -> nozzle 1, slot 2 -> nozzle 2: this is what produces T0/T1
  filament_map: ['1', '2'],
  filament_map_mode: 'Manual',
  // 2 nozzles x 2 filaments squared; 0 to purge a filament into itself
  flush_volumes_matrix: ['0', '280', '280', '0', '0', '280', '280', '0'],
  flush_multiplier: ['1', '1'],
  // The prime tower the flush volumes above flush into. The engine default is
  // off, so a multi-material plate has to turn it on explicitly (#163) — this
  // mirrors what withFilamentSlots() now emits, including its two companions:
  // the wipe tower validates only under relative extruder addressing, and that
  // addressing needs a per-layer "G92 E0" reset on a Marlin, non-Bambu printer
  // (this config is one — no "Bambu Lab" printer_model) or Print::validate()
  // hard-fails the slice. See withPrimeTowerAddressing() in src/lib/profiles.ts.
  enable_prime_tower: '1',
  use_relative_e_distances: '1',
  before_layer_change_gcode: 'G92 E0',
}

// Single-nozzle AMS with two slots sharing the one nozzle, on a shallow 210 mm
// bed (a Prusa MK4). Both slots are the same material so the engine's
// mixed-nozzle-temperature guard (which fires only when filaments share a
// nozzle) doesn't reject the slice — this scenario is about placement, not
// temperature. The prime tower's engine-default position (15, 220) is off the
// back of a 210 mm bed; clamp_wipe_tower_to_bed in bridge/slicer.cpp is what
// keeps it on. See #163.
const SMALL_BED_AMS_CONFIG = {
  ...BASE_CONFIG,
  bed_size_y: 210,
  filament_type: ['PLA', 'PLA'],
  filament_colour: ['#F5A623', '#4A90D9'],
  filament_diameter: ['1.75', '1.75'],
  nozzle_temperature: ['220', '220'],
  nozzle_temperature_initial_layer: ['220', '220'],
  hot_plate_temp: ['55', '55'],
  hot_plate_temp_initial_layer: ['55', '55'],
  filament_start_gcode: ['', ''],
  filament_end_gcode: ['', ''],
  filament_map: ['1', '1'],
  filament_map_mode: 'Manual',
  flush_volumes_matrix: ['0', '280', '280', '0'],
  flush_multiplier: ['1'],
  enable_prime_tower: '1',
  use_relative_e_distances: '1',
  before_layer_change_gcode: 'G92 E0',
}

// Single-nozzle AMS with two filaments whose recommended nozzle-temperature
// ranges don't overlap (PLA ~190–230, PETG ~220–260) sharing one nozzle. The
// engine's mixed-temperature guard (Print::check_multi_filament_valid) rejects
// this with -6 by default; setting remove_mixed_temp_restriction makes the
// bridge call Print::set_check_multi_filaments_compatibility(false) so it
// slices anyway. Both the rejection and the override are asserted below (#164).
const MIXED_TEMP_AMS_CONFIG = {
  ...BASE_CONFIG,
  filament_type: ['PLA', 'PETG'],
  filament_colour: ['#F5A623', '#4A90D9'],
  filament_diameter: ['1.75', '1.75'],
  nozzle_temperature: ['220', '255'],
  nozzle_temperature_initial_layer: ['220', '255'],
  hot_plate_temp: ['55', '70'],
  hot_plate_temp_initial_layer: ['55', '70'],
  filament_start_gcode: ['', ''],
  filament_end_gcode: ['', ''],
  // both slots share nozzle 1 — this is what makes the guard fire (a genuine
  // dual-nozzle machine is exempt: each nozzle holds its own temperature).
  filament_map: ['1', '1'],
  filament_map_mode: 'Manual',
  flush_volumes_matrix: ['0', '280', '280', '0'],
  flush_multiplier: ['1'],
  enable_prime_tower: '1',
  use_relative_e_distances: '1',
  before_layer_change_gcode: 'G92 E0',
}

// Both nozzles actually used. A config that silently collapsed to a single
// filament still slices and still passes assertSaneGcode() — it just prints
// everything with one tool, which is precisely the failure mode #140's
// comma-joining produced once it stopped crashing outright.
function assertToolChanges(gcode, label) {
  const tools = new Set()
  for (const line of gcode.split('\n')) {
    const m = line.match(/^T(\d+)\b/)
    if (m) tools.add(m[1])
  }
  if (!tools.has('0') || !tools.has('1')) {
    throw new Error(`${label}: expected both T0 and T1 tool changes, saw [${[...tools].join(',') || 'none'}]`)
  }
}

// The prime tower has to sit on the bed. OrcaSlicer's fit-and-clamp is GUI-only,
// so the WASM bridge ports it (clamp_wipe_tower_to_bed in bridge/slicer.cpp);
// without that a small bed keeps the engine default (15, 220) and the tower
// hangs off the back edge. Reads the position the bridge wrote from the config
// block the engine appends to the G-code.
function assertWipeTowerOnBed(gcode, bedX, bedY, label) {
  const x = parseFloat(gcode.match(/;\s*wipe_tower_x\s*=\s*([\-0-9.]+)/)?.[1])
  const y = parseFloat(gcode.match(/;\s*wipe_tower_y\s*=\s*([\-0-9.]+)/)?.[1])
  if (!(x >= 0 && x < bedX) || !(y >= 0 && y < bedY)) {
    throw new Error(`${label}: prime tower origin (${x}, ${y}) is off a ${bedX}x${bedY} bed`)
  }
}

// ── test meshes ──────────────────────────────────────────────────────────────
// Repo root — this script lives in orca-wasm/scripts/.
const VORON_CUBE_PATH = resolve(import.meta.dirname, '../../e2e/fixtures/voron-design-cube-v7.stl')

function collectMeshes(fixture) {
  if (fixture) {
    return [{ label: fixture, bytes: readFileSync(fixture) }]
  }
  const meshes = [{ label: 'synthetic icosphere (~5120 tris)', bytes: generateTortureStl() }]
  if (existsSync(VORON_CUBE_PATH)) {
    meshes.push({ label: 'Voron Design Cube v7 (real-world)', bytes: readFileSync(VORON_CUBE_PATH) })
  } else {
    console.warn(`[smoke-test] WARN: ${VORON_CUBE_PATH} not found — skipping the real-world mesh`)
  }
  return meshes
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { wasmDir, engine, fixture } = parseArgs(process.argv.slice(2))
  console.log(`[smoke-test] loading engine "${engine}" from ${wasmDir}...`)
  const module = await loadModule(wasmDir, engine)
  console.log('[smoke-test] engine loaded')

  const meshes = collectMeshes(fixture)
  for (const mesh of meshes) {
    console.log(`[smoke-test] mesh: ${mesh.label} (${mesh.bytes.length} bytes)`)
  }

  const session = module._orc_session_create()
  if (!session) throw new Error('orc_session_create failed (allocation failure)')

  const scenarios = [
    {
      name: 'default (Arachne walls, no fuzzy skin)',
      config: BASE_CONFIG,
    },
    {
      name: 'fuzzy skin = all',
      config: { ...BASE_CONFIG, fuzzy_skin: 'all', fuzzy_skin_thickness: 0.3, fuzzy_skin_point_dist: 0.8 },
    },
    {
      name: 'classic wall generator (regression control vs. Arachne default)',
      config: { ...BASE_CONFIG, wall_generator: 'classic' },
    },
    {
      // Adaptive layer height is a bridge pseudo-key (#138) — the engine
      // computes each object's layer_height_profile before slicing. The extra
      // assert confirms the layer thickness actually varies, not just that the
      // slice succeeds (the pseudo-key being silently ignored would still emit
      // valid, uniform-height G-code).
      name: 'adaptive (variable) layer height',
      config: { ...BASE_CONFIG, adaptive_layer_height: true, adaptive_layer_height_quality: 0.5 },
      assert: assertVariableLayerHeights,
    },
  ]

  let failures = 0
  for (const mesh of meshes) {
    for (const scenario of scenarios) {
      const label = `[${mesh.label}] ${scenario.name}`
      process.stdout.write(`[smoke-test] ${label} ... `)
      try {
        initSession(module, session, JSON.stringify(scenario.config))
        const gcode = sliceOnce(module, session, mesh.bytes)
        assertSaneGcode(gcode, label)
        assertRestsOnBed(gcode, label, scenario.config.initial_layer_height)
        scenario.assert?.(gcode, label)
        console.log(`PASS (${gcode.length} bytes)`)
      } catch (err) {
        failures++
        console.log('FAIL')
        console.error(`  ${err.message}`)
      }
    }

    // Multi-object plate with a per-object "extruder" override (same value on
    // both objects, nozzle_diameter length 1) — the AMS-style path, probing
    // the orc_slice_multi extruder_ids plumbing on its own. The genuinely
    // multi-nozzle case is the scenario below.
    const plateLabel = `[${mesh.label}] plate: 2 objects, per-object extruder override (single nozzle)`
    process.stdout.write(`[smoke-test] ${plateLabel} ... `)
    try {
      initSession(module, session, JSON.stringify(BASE_CONFIG))
      const gcode = sliceMultiOnce(module, session, [mesh.bytes, mesh.bytes], Int32Array.from([1, 1]))
      assertSaneGcode(gcode, plateLabel)
      assertRestsOnBed(gcode, plateLabel, BASE_CONFIG.initial_layer_height)
      console.log(`PASS (${gcode.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // Real multi-nozzle: two objects on one plate, each assigned to a slot
    // that maps to a different physical nozzle. See DUAL_NOZZLE_CONFIG above
    // for why this scenario is committed rather than run by hand (#140).
    const dualLabel = `[${mesh.label}] plate: 2 objects on a real dual-nozzle machine (T0 + T1)`
    process.stdout.write(`[smoke-test] ${dualLabel} ... `)
    try {
      initSession(module, session, JSON.stringify(DUAL_NOZZLE_CONFIG))
      const gcode = sliceMultiOnce(module, session, [mesh.bytes, mesh.bytes], Int32Array.from([1, 2]))
      assertSaneGcode(gcode, dualLabel)
      assertRestsOnBed(gcode, dualLabel, BASE_CONFIG.initial_layer_height)
      assertToolChanges(gcode, dualLabel)
      console.log(`PASS (${gcode.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // Prime tower placement: a multi-material plate on a shallow bed whose
    // engine-default tower position would hang off the back edge. Guards the
    // bridge's clamp (#163) — without it the tower origin sits at y=220 on a
    // 210 mm bed.
    const towerLabel = `[${mesh.label}] plate: prime tower clamped onto a shallow bed`
    process.stdout.write(`[smoke-test] ${towerLabel} ... `)
    try {
      initSession(module, session, JSON.stringify(SMALL_BED_AMS_CONFIG))
      const gcode = sliceMultiOnce(module, session, [mesh.bytes, mesh.bytes], Int32Array.from([1, 2]))
      assertSaneGcode(gcode, towerLabel)
      assertToolChanges(gcode, towerLabel)
      assertWipeTowerOnBed(gcode, SMALL_BED_AMS_CONFIG.bed_size_x, SMALL_BED_AMS_CONFIG.bed_size_y, towerLabel)
      console.log(`PASS (${gcode.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // Mixed-temperature single-nozzle guard (#164): without the override the
    // engine must reject the plate with -6; with it the same plate slices. Both
    // halves matter — a bridge that ignored the flag would pass the second
    // check by never enforcing the guard, so the first check pins that the
    // guard is still on by default.
    const guardLabel = `[${mesh.label}] plate: mixed-temp single nozzle is rejected without the override`
    process.stdout.write(`[smoke-test] ${guardLabel} ... `)
    try {
      initSession(module, session, JSON.stringify(MIXED_TEMP_AMS_CONFIG))
      let rejected = false
      try {
        sliceMultiOnce(module, session, [mesh.bytes, mesh.bytes], Int32Array.from([1, 2]))
      } catch (err) {
        rejected = true
        if (!/\(-6\)/.test(err.message) || !/incompatible/i.test(err.message)) {
          throw new Error(`expected an incompatible-temperature -6 rejection, got: ${err.message}`)
        }
        // The message must still carry the desktop menu path that
        // humanizeSliceError() (src/lib/wasm-loader.ts) rewrites into the
        // in-app toggle. If a future engine reworded this tail, the frontend
        // rewrite would silently no-op — pin the anchor here so that drift is
        // caught at the engine boundary rather than in production (#164).
        if (!/Preferences\s*\/\s*Control\s*\/\s*Slicing\s*\/\s*Remove mixed temperature restriction/.test(err.message)) {
          throw new Error(`rejection message lost the desktop menu-path anchor humanizeSliceError keys on: ${err.message}`)
        }
      }
      if (!rejected) throw new Error('expected the slice to be rejected, but it succeeded')
      console.log('PASS (rejected as expected)')
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    const overrideLabel = `[${mesh.label}] plate: mixed-temp single nozzle slices with the override on`
    process.stdout.write(`[smoke-test] ${overrideLabel} ... `)
    try {
      initSession(module, session, JSON.stringify({ ...MIXED_TEMP_AMS_CONFIG, remove_mixed_temp_restriction: '1' }))
      const gcode = sliceMultiOnce(module, session, [mesh.bytes, mesh.bytes], Int32Array.from([1, 2]))
      assertSaneGcode(gcode, overrideLabel)
      assertToolChanges(gcode, overrideLabel)
      console.log(`PASS (${gcode.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // orc_write_3mf: mesh + embedded config, no plate/gcode data (see
    // orca-wasm/bridge/slicer.cpp doc comment and issue #108's scope notes).
    const write3mfLabel = `[${mesh.label}] write .3mf (mesh + embedded config)`
    process.stdout.write(`[smoke-test] ${write3mfLabel} ... `)
    let written3mf = null
    try {
      initSession(module, session, JSON.stringify(BASE_CONFIG))
      written3mf = write3mfOnce(module, session, mesh.bytes)
      assertValid3mf(written3mf, write3mfLabel)
      console.log(`PASS (${written3mf.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // orc_read_3mf: round-trip the .3mf just written back through the
    // engine's own reader — mesh triangle count and a few config keys must
    // survive (per issue #108's read-path test plan).
    const read3mfLabel = `[${mesh.label}] read .3mf (round-trip mesh + config)`
    process.stdout.write(`[smoke-test] ${read3mfLabel} ... `)
    try {
      if (!written3mf) throw new Error('no .3mf available (write step failed above)')
      const { stl, configJson } = read3mfOnce(module, written3mf)

      const expectedTris = stlTriangleCount(mesh.bytes)
      const actualTris = stlTriangleCount(stl)
      if (actualTris !== expectedTris) {
        throw new Error(`triangle count mismatch: expected ${expectedTris}, got ${actualTris}`)
      }

      const config = JSON.parse(configJson)
      for (const key of ['layer_height', 'nozzle_temperature', 'filament_type', 'sparse_infill_density']) {
        if (!(key in config)) throw new Error(`config key "${key}" missing from round-tripped .3mf (keys: ${Object.keys(config).join(', ')})`)
      }
      if (parseFloat(config.layer_height) !== BASE_CONFIG.layer_height) {
        throw new Error(`layer_height mismatch: expected ${BASE_CONFIG.layer_height}, got ${config.layer_height}`)
      }

      console.log(`PASS (${actualTris} tris, ${Object.keys(config).length} config keys)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }
  }

  module._orc_session_destroy(session)

  if (failures > 0) {
    console.error(`\n[smoke-test] ${failures} scenario(s) failed`)
    process.exit(1)
  }
  console.log('\n[smoke-test] all scenarios passed')
}

main().catch((err) => {
  console.error('[smoke-test] fatal:', err.stack ?? err)
  process.exit(1)
})
