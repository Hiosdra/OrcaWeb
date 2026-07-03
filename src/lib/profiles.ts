import type { OrcaConfig, SlicePreset } from '../types'

export const PRESETS: SlicePreset[] = [
  {
    name: 'draft',
    label: 'Draft',
    description: 'Fast print, lower quality',
    config: {
      layer_height: 0.3,
      initial_layer_height: 0.35,
      wall_loops: 2,
      sparse_infill_density: 10,
      top_shell_layers: 3,
      bottom_shell_layers: 3,
      default_speed: 150,
      outer_wall_speed: 80,
      initial_layer_speed: 40,
      travel_speed: 200,
    },
  },
  {
    name: 'standard',
    label: 'Standard',
    description: 'Balanced quality and speed',
    config: {
      layer_height: 0.2,
      initial_layer_height: 0.25,
      wall_loops: 3,
      sparse_infill_density: 15,
      top_shell_layers: 4,
      bottom_shell_layers: 4,
      default_speed: 100,
      outer_wall_speed: 60,
      initial_layer_speed: 30,
      travel_speed: 150,
    },
  },
  {
    name: 'fine',
    label: 'Fine',
    description: 'High quality, slower print',
    config: {
      layer_height: 0.1,
      initial_layer_height: 0.15,
      wall_loops: 4,
      sparse_infill_density: 20,
      top_shell_layers: 5,
      bottom_shell_layers: 5,
      default_speed: 60,
      outer_wall_speed: 40,
      initial_layer_speed: 20,
      travel_speed: 120,
    },
  },
]

export const FILAMENT_PRESETS: Record<string, Partial<OrcaConfig>> = {
  PLA: {
    filament_type: 'PLA',
    nozzle_temperature: 220,
    bed_temperature: 60,
    fan_min_speed: 100,
  },
  PETG: {
    filament_type: 'PETG',
    nozzle_temperature: 240,
    bed_temperature: 80,
    fan_min_speed: 50,
  },
  ABS: {
    filament_type: 'ABS',
    nozzle_temperature: 255,
    bed_temperature: 100,
    fan_min_speed: 0,
  },
  TPU: {
    filament_type: 'TPU',
    nozzle_temperature: 230,
    bed_temperature: 50,
    fan_min_speed: 50,
  },
}

// bed_size_x/y and printable_height are cross-checked against OrcaSlicer's own
// bundled profiles (resources/profiles/<Vendor>/machine/*.json) — our headless
// WASM build ships none of these, so the web UI's hardcoded presets are the
// only source of truth for them. printable_height in particular used to be
// missing from every preset here, silently falling back to the *engine's*
// generic FullPrintConfig default of 100mm (PrintConfig.cpp) — well under
// any of these printers' real Z height, so any model taller than 100mm
// failed "exceeds the maximum build volume height" validation regardless of
// which printer was selected.
export const PRINTER_PRESETS: Record<string, Partial<OrcaConfig>> = {
  'Generic 0.4': {
    printer_model: 'Generic',
    nozzle_diameter: 0.4,
    bed_size_x: 256,
    bed_size_y: 256,
    printable_height: 250,
  },
  'Generic 0.6': {
    printer_model: 'Generic',
    nozzle_diameter: 0.6,
    bed_size_x: 256,
    bed_size_y: 256,
    printable_height: 250,
  },
  'Bambu Lab P1S': {
    printer_model: 'BambuLab P1S',
    nozzle_diameter: 0.4,
    bed_size_x: 256,
    bed_size_y: 256,
    // Real printable_area (fdm_bbl_3dp_001_common.json) is a square
    // ["0x0","256x0","256x256","0x256"], not circular — 'circle' here was
    // wrong (delta-printer bed shape, doesn't apply to Bambu's CoreXY beds).
    printable_height: 250,
    default_speed: 300,
    outer_wall_speed: 150,
    travel_speed: 500,
  },
  'Bambu Lab X1C': {
    printer_model: 'BambuLab X1C',
    nozzle_diameter: 0.4,
    bed_size_x: 256,
    bed_size_y: 256,
    printable_height: 250,
    default_speed: 350,
    outer_wall_speed: 200,
    travel_speed: 600,
  },
  'Creality Ender 3': {
    printer_model: 'Creality Ender-3',
    nozzle_diameter: 0.4,
    bed_size_x: 220,
    bed_size_y: 220,
    printable_height: 250,
    default_speed: 60,
    outer_wall_speed: 40,
    travel_speed: 120,
  },
  'Prusa MK4': {
    printer_model: 'Prusa MK4',
    nozzle_diameter: 0.4,
    bed_size_x: 250,
    bed_size_y: 210,
    printable_height: 220,
    default_speed: 120,
    outer_wall_speed: 80,
    travel_speed: 200,
  },
  'Voron 2.4': {
    printer_model: 'Voron 2.4',
    nozzle_diameter: 0.4,
    bed_size_x: 300,
    bed_size_y: 300,
    // OrcaSlicer's "Voron 2.4 300" profile (300x300 bed variant) ships
    // printable_height: 275, not the full 300 the bed size might suggest.
    printable_height: 275,
    default_speed: 200,
    outer_wall_speed: 100,
    travel_speed: 350,
  },
}

export function buildConfig(
  printer: string,
  filament: string,
  preset: string,
  overrides: Partial<OrcaConfig> = {},
): OrcaConfig {
  return {
    ...PRINTER_PRESETS[printer],
    ...FILAMENT_PRESETS[filament],
    ...(PRESETS.find((p) => p.name === preset)?.config ?? {}),
    ...overrides,
  }
}

// OrcaSlicer profile field → OrcaConfig key mapping.
// OrcaSlicer often encodes numbers as strings (e.g. "0.2") and percentages as "15%".
const ORCA_FIELD_MAP: Record<string, { key: keyof OrcaConfig; type: 'num' | 'pct' | 'bool' | 'str' }> = {
  layer_height:            { key: 'layer_height',           type: 'num' },
  initial_layer_height:    { key: 'initial_layer_height',   type: 'num' },
  wall_loops:              { key: 'wall_loops',             type: 'num' },
  perimeters:              { key: 'wall_loops',             type: 'num' }, // alias
  top_shell_layers:        { key: 'top_shell_layers',       type: 'num' },
  bottom_shell_layers:     { key: 'bottom_shell_layers',    type: 'num' },
  sparse_infill_density:   { key: 'sparse_infill_density',  type: 'pct' },
  fill_density:            { key: 'sparse_infill_density',  type: 'pct' }, // alias
  sparse_infill_pattern:   { key: 'sparse_infill_pattern',  type: 'str' },
  fill_pattern:            { key: 'sparse_infill_pattern',  type: 'str' },
  outer_wall_speed:        { key: 'outer_wall_speed',       type: 'num' },
  external_perimeter_speed:{ key: 'outer_wall_speed',       type: 'num' },
  default_speed:           { key: 'default_speed',          type: 'num' },
  inner_wall_speed:        { key: 'default_speed',          type: 'num' },
  travel_speed:            { key: 'travel_speed',           type: 'num' },
  initial_layer_speed:     { key: 'initial_layer_speed',    type: 'num' },
  first_layer_speed:       { key: 'initial_layer_speed',    type: 'num' },
  brim_width:              { key: 'brim_width',             type: 'num' },
  seam_position:           { key: 'seam_position',          type: 'str' },
  enable_support:          { key: 'enable_support',         type: 'bool' },
  support_type:            { key: 'support_type',           type: 'str' },
  enable_ironing:          { key: 'enable_ironing',         type: 'bool' },
  ironing:                 { key: 'enable_ironing',         type: 'bool' },
  fuzzy_skin:              { key: 'fuzzy_skin',             type: 'str' },
  fuzzy_skin_thickness:    { key: 'fuzzy_skin_thickness',   type: 'num' },
  fuzzy_skin_point_dist:   { key: 'fuzzy_skin_point_dist',  type: 'num' },
  // filament fields
  filament_type:           { key: 'filament_type',          type: 'str' },
  nozzle_temperature:      { key: 'nozzle_temperature',     type: 'num' },
  temperature:             { key: 'nozzle_temperature',     type: 'num' },
  bed_temperature:         { key: 'bed_temperature',        type: 'num' },
  hot_plate_temp:          { key: 'bed_temperature',        type: 'num' },
  fan_min_speed:           { key: 'fan_min_speed',          type: 'num' },
  // machine fields
  printer_model:           { key: 'printer_model',          type: 'str' },
  nozzle_diameter:         { key: 'nozzle_diameter',        type: 'num' },
  printable_height:        { key: 'printable_height',       type: 'num' },
  max_print_height:        { key: 'printable_height',       type: 'num' }, // alias
  bed_shape:               { key: 'bed_shape',              type: 'str' },
  // bed size — handled separately via parsePrintableArea() below
}

/**
 * Parse bed size from OrcaSlicer's `printable_area` field.
 *
 * OrcaSlicer stores bed corners as an array of "XxY" strings, e.g.:
 *   ["0x0", "256x0", "256x256", "0x256"]
 * or as a flat comma-joined string: "0x0,256x0,256x256,0x256"
 *
 * Returns { dims: [maxX, maxY], circle: boolean } or null if unparseable.
 * When the polygon has more than 8 points it's treated as a circular bed.
 */
function parsePrintableArea(raw: unknown): { dims: [number, number]; circle: boolean } | null {
  let pts: string[]
  if (Array.isArray(raw)) {
    pts = raw.map(String)
  } else {
    const s = String(raw).trim()
    if (!s) return null
    pts = s.split(',')
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  let pointCount = 0
  for (const pt of pts) {
    const parts = pt.trim().split('x')
    if (parts.length < 2) continue
    const x = parseFloat(parts[0]), y = parseFloat(parts[1])
    if (!isNaN(x) && !isNaN(y)) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      pointCount++
    }
  }
  // Bed size is the bounding-box extent. For corner-origin rectangular beds the
  // origin is (0,0) so this equals maxX/maxY; for center-origin circular/delta
  // beds (coords −r..+r) this gives the full diameter, not the radius.
  const sizeX = maxX - minX, sizeY = maxY - minY
  if (!(sizeX > 0) || !(sizeY > 0)) return null
  // Circular beds are approximated as polygons with many vertices in OrcaSlicer profiles.
  return { dims: [sizeX, sizeY], circle: pointCount > 8 }
}

export function parseOrcaProfileJson(json: string): Partial<OrcaConfig> {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>

    // Support array-wrapped values (OrcaSlicer wraps some fields: ["0.2"])
    function unwrap(v: unknown): unknown {
      return Array.isArray(v) && v.length === 1 ? v[0] : v
    }

    const config: Partial<OrcaConfig> = {}

    for (const [field, meta] of Object.entries(ORCA_FIELD_MAP)) {
      if (!(field in raw)) continue
      const raw_val = unwrap(raw[field])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = config as any
      if (meta.type === 'num') {
        const n = parseFloat(String(raw_val))
        if (!isNaN(n)) out[meta.key] = n
      } else if (meta.type === 'pct') {
        // "15%" → 15, "0.15" → 15, "15" → 15 (OrcaSlicer integer), "1" → 1 (not 100)
        const s = String(raw_val).trim()
        const parsed = parseFloat(s)
        const n = s.endsWith('%') ? parsed : parsed < 1 ? parsed * 100 : parsed
        if (!isNaN(n)) out[meta.key] = Math.round(n)
      } else if (meta.type === 'bool') {
        const s = String(raw_val).toLowerCase()
        out[meta.key] = s === '1' || s === 'true' || s === 'yes'
      } else {
        out[meta.key] = String(raw_val)
      }
    }

    // ── Bed size ─────────────────────────────────────────────────────────────
    // OrcaSlicer machine profiles carry printable_area / bed_size for bed dims.
    if ('printable_area' in raw) {
      const result = parsePrintableArea(raw['printable_area'])
      if (result) {
        config.bed_size_x = result.dims[0]
        config.bed_size_y = result.dims[1]
        if (result.circle && !config.bed_shape) config.bed_shape = 'circle'
      }
    } else if ('bed_size' in raw) {
      // Some older profiles use bed_size: ["256", "256"] or "256x256"
      const bs = unwrap(raw['bed_size'])
      if (Array.isArray(bs) && bs.length >= 2) {
        const x = parseFloat(String(bs[0])), y = parseFloat(String(bs[1]))
        if (!isNaN(x) && x > 0) config.bed_size_x = x
        if (!isNaN(y) && y > 0) config.bed_size_y = y
      } else {
        const result = parsePrintableArea(bs)
        if (result) {
          config.bed_size_x = result.dims[0]
          config.bed_size_y = result.dims[1]
          if (result.circle && !config.bed_shape) config.bed_shape = 'circle'
        }
      }
    }

    // ── Passthrough for unmapped OrcaSlicer fields ───────────────────────────
    // Collect every field not already processed so it can be forwarded verbatim
    // to the WASM slicer (which accepts any DynamicPrintConfig key).
    const SKIP_META = new Set(['type', 'name', 'inherits', 'from', 'version', 'description', '__proto__', 'constructor', 'prototype'])
    const SKIP_BED  = new Set(['printable_area', 'bed_size'])
    const alreadyMapped = new Set(Object.keys(ORCA_FIELD_MAP))
    const passthrough: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [field, val] of Object.entries(raw)) {
      if (SKIP_META.has(field) || SKIP_BED.has(field) || alreadyMapped.has(field)) continue
      if (val === null || val === undefined) continue
      let sv: string
      if (Array.isArray(val)) {
        // OrcaSlicer wraps values in arrays (single-extruder: ["0.8"], multi: ["0.8","1.0"]).
        // OrcaSlicer's config deserializer expects multi-value options as comma-separated strings.
        sv = val
          .filter((x) => x !== null && x !== undefined)
          .map((x) => (typeof x === 'boolean' ? (x ? '1' : '0') : String(x)))
          .join(',')
      } else {
        sv = typeof val === 'boolean' ? (val ? '1' : '0') : String(val)
      }
      if (sv !== '') passthrough[field] = sv
    }
    if (Object.keys(passthrough).length > 0) config._passthrough = passthrough

    return config
  } catch {
    return {}
  }
}
