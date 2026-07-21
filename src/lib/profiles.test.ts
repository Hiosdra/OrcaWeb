import { describe, expect, it } from 'vitest'
import type { OrcaConfig } from '../types'
import { exportOrcaProfileBundle, exportOrcaProfileJson, filamentSlots, parseOrcaProfileJson } from './profiles'

describe('filamentSlots', () => {
  it('returns a single slot for a plain filament_type', () => {
    expect(filamentSlots({ filament_type: 'PLA' })).toEqual(['PLA'])
  })

  it('splits a semicolon-joined AMS-style filament_type into slots', () => {
    expect(filamentSlots({ filament_type: 'PLA;PETG;ABS;TPU' })).toEqual(['PLA', 'PETG', 'ABS', 'TPU'])
  })

  it('falls back to the display default when unset', () => {
    expect(filamentSlots({})).toEqual(['PLA'])
  })
})

describe('exportOrcaProfileBundle', () => {
  const config: OrcaConfig = {
    // process
    layer_height: 0.16,
    initial_layer_print_height: 0.24,
    wall_loops: 4,
    top_shell_layers: 5,
    bottom_shell_layers: 3,
    sparse_infill_density: 20,
    sparse_infill_pattern: 'gyroid',
    enable_support: true,
    support_type: 'tree(auto)',
    brim_width: 5,
    brim_type: 'outer_and_inner',
    skirt_loops: 2,
    skirt_distance: 3,
    raft_layers: 4,
    // filament
    nozzle_temperature: 230,
    bed_temperature: 65,
    // machine
    nozzle_diameter: 0.6,
    bed_size_x: 220,
    bed_size_y: 220,
  }

  it('splits fields into their real OrcaSlicer preset category, with no cross-category leakage', () => {
    const bundle = exportOrcaProfileBundle(config, 'test')
    const byFile = Object.fromEntries(bundle.map((f) => [f.filename, JSON.parse(f.json) as Record<string, unknown>]))

    expect(byFile['process.json'].type).toBe('process')
    expect(byFile['process.json'].layer_height).toBe('0.16')
    expect(byFile['process.json'].initial_layer_print_height).toBe('0.24')
    expect(byFile['process.json'].brim_type).toBe('outer_and_inner')
    // machine/filament-only fields must not leak into the process file
    expect(byFile['process.json'].nozzle_diameter).toBeUndefined()
    expect(byFile['process.json'].nozzle_temperature).toBeUndefined()
    expect(byFile['process.json'].printable_area).toBeUndefined()

    expect(byFile['filament.json'].type).toBe('filament')
    expect(byFile['filament.json'].nozzle_temperature).toBe('230')
    expect(byFile['filament.json'].layer_height).toBeUndefined()
    expect(byFile['filament.json'].nozzle_diameter).toBeUndefined()

    expect(byFile['machine.json'].type).toBe('machine')
    expect(byFile['machine.json'].nozzle_diameter).toBe('0.6')
    expect(byFile['machine.json'].printable_area).toEqual(['0x0', '220x0', '220x220', '0x220'])
    expect(byFile['machine.json'].layer_height).toBeUndefined()
    expect(byFile['machine.json'].nozzle_temperature).toBeUndefined()
  })

  // These assert the raw exported key names, which a round-trip through this
  // app's own parseOrcaProfileJson cannot catch: it recognizes the synthetic
  // names too, so a profile that desktop OrcaSlicer would silently strip
  // still round-trips perfectly here.
  it('writes bed temperature as the real hot_plate_temp fields, not the synthetic bed_temperature', () => {
    const filament = JSON.parse(exportOrcaProfileJson(config, 'test', 'filament')) as Record<string, unknown>
    expect(filament.hot_plate_temp).toBe('65')
    expect(filament.hot_plate_temp_initial_layer).toBe('65')
    expect(filament.bed_temperature).toBeUndefined()
  })

  // Verified against a stock OrcaSlicer 2.4.2: without compatible_printers
  // the process/filament presets are rejected on load ("process not
  // compatible with printer", CLI exit -17), and an empty list doesn't mean
  // "any printer". The name follows OrcaSlicer's machine-preset convention.
  it('names the compatible printer on process and filament presets', () => {
    const cfg: OrcaConfig = { printer_model: 'Bambu Lab P1S', nozzle_diameter: 0.4, layer_height: 0.2 }
    const process = JSON.parse(exportOrcaProfileJson(cfg, 'p', 'process')) as Record<string, unknown>
    const filament = JSON.parse(exportOrcaProfileJson(cfg, 'p', 'filament')) as Record<string, unknown>
    const machine = JSON.parse(exportOrcaProfileJson(cfg, 'p', 'machine')) as Record<string, unknown>
    expect(process.compatible_printers).toEqual(['Bambu Lab P1S 0.4 nozzle'])
    expect(filament.compatible_printers).toEqual(['Bambu Lab P1S 0.4 nozzle'])
    // A machine preset naming itself as its own compatible printer is
    // meaningless — it inherits from the stock printer instead, which is what
    // makes OrcaSlicer accept it as a printer at all.
    expect(machine.compatible_printers).toBeUndefined()
    expect(machine.inherits).toBe('Bambu Lab P1S 0.4 nozzle')
    expect(process.inherits).toBeUndefined()
  })

  it('omits compatible_printers when the printer is not fully known', () => {
    const parsed = JSON.parse(exportOrcaProfileJson({ layer_height: 0.2 }, 'p', 'process')) as Record<string, unknown>
    expect(parsed.compatible_printers).toBeUndefined()
  })

  it('never writes bed_shape — real machine profiles carry bed geometry only in printable_area', () => {
    const machine = JSON.parse(exportOrcaProfileJson({ bed_shape: 'circle' }, 'p', 'machine')) as Record<
      string,
      unknown
    >
    expect(machine.bed_shape).toBeUndefined()
  })

  it('round-trips every field when the three files are merged back through parseOrcaProfileJson', () => {
    const bundle = exportOrcaProfileBundle(config, 'test')
    const merged: Partial<OrcaConfig> = {}
    for (const f of bundle) Object.assign(merged, parseOrcaProfileJson(f.json))
    expect(merged).toMatchObject(config)
  })
})

describe('exportOrcaProfileJson', () => {
  it('writes percentages back in OrcaSlicer\'s "NN%" format', () => {
    const json = exportOrcaProfileJson({ sparse_infill_density: 33 }, 'p', 'process')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.sparse_infill_density).toBe('33%')
  })

  it('passes _passthrough fields through verbatim', () => {
    const json = exportOrcaProfileJson({ _passthrough: { some_unmapped_field: '42' } }, 'p', 'process')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.some_unmapped_field).toBe('42')
  })

  it('writes the real inner_wall_speed field for default_speed, not the synthetic OrcaConfig-only name', () => {
    // Round-tripping through this app's own parseOrcaProfileJson can't catch
    // a wrong field name here — it recognizes both the real and synthetic
    // names — so this asserts the raw JSON keys directly, matching what a
    // real desktop OrcaSlicer install (which only recognizes the real name)
    // would actually see.
    const json = exportOrcaProfileJson({ default_speed: 120 }, 'p', 'process')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.inner_wall_speed).toBe('120')
    expect(parsed.default_speed).toBeUndefined()
  })

  it('writes the real ironing_type enum field for enable_ironing, not a nonexistent "ironing"/"enable_ironing" key', () => {
    // "ironing"/"enable_ironing" aren't real OrcaSlicer options (verified
    // against PrintConfig.cpp) — the real field is ironing_type, an enum
    // ("no ironing"/"top"/"topmost"/"solid"), not a boolean. A round trip
    // through this app's own parser can't catch a wrong key/value shape
    // here either, so this asserts the raw JSON directly.
    const on = JSON.parse(exportOrcaProfileJson({ enable_ironing: true }, 'p', 'process')) as Record<string, unknown>
    expect(on.ironing_type).toBe('top')
    expect(on.ironing).toBeUndefined()
    expect(on.enable_ironing).toBeUndefined()

    const off = JSON.parse(exportOrcaProfileJson({ enable_ironing: false }, 'p', 'process')) as Record<string, unknown>
    expect(off.ironing_type).toBe('no ironing')
  })
})

describe('parseOrcaProfileJson ironing_type', () => {
  it('treats any non-empty value other than "no ironing" as enabled', () => {
    expect(parseOrcaProfileJson(JSON.stringify({ ironing_type: 'top' })).enable_ironing).toBe(true)
    expect(parseOrcaProfileJson(JSON.stringify({ ironing_type: 'topmost' })).enable_ironing).toBe(true)
    expect(parseOrcaProfileJson(JSON.stringify({ ironing_type: 'solid' })).enable_ironing).toBe(true)
    expect(parseOrcaProfileJson(JSON.stringify({ ironing_type: 'no ironing' })).enable_ironing).toBe(false)
  })
})

describe('parseOrcaProfileJson initial_layer_print_height', () => {
  it('maps the real FFF field name, not the SLA-only initial_layer_height', () => {
    const parsed = parseOrcaProfileJson(JSON.stringify({ initial_layer_print_height: '0.24' }))
    expect(parsed.initial_layer_print_height).toBe(0.24)
  })

  it("does not pick up an SLA profile's unrelated initial_layer_height field", () => {
    const parsed = parseOrcaProfileJson(JSON.stringify({ initial_layer_height: '0.3' }))
    expect(parsed.initial_layer_print_height).toBeUndefined()
    // Falls through to _passthrough instead of being silently dropped or
    // misapplied to the FFF field.
    expect(parsed._passthrough?.initial_layer_height).toBe('0.3')
  })
})
