import { describe, expect, it } from 'vitest'
import type { OrcaConfig } from '../types'
import {
  describeExportCompatibility,
  exportOrcaProfileBundle,
  exportOrcaProfileJson,
  filamentSlots,
  MAX_FILAMENT_SLOTS,
  parseOrcaProfileJson,
  withFilamentSlots,
} from './profiles'

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

  it('names only the stock preset — the one string the compatibility check compares against', () => {
    // Measured against OrcaSlicer 2.4.2's CLI: each compatible_printers entry
    // is tested against the printer preset's `inherits`, never against its
    // name. Listing the bundle's own machine file here reads like it would
    // make the three files refer to each other, but it is inert — a bundle
    // whose list contains only that name is rejected (-17) even though that
    // file is the printer being loaded. Keeping the list to the one string
    // that is actually matched is what makes it load.
    const bundle = exportOrcaProfileBundle({ ...config, printer_model: 'Bambu Lab P1S' }, 'test')
    const byCategory = Object.fromEntries(
      bundle.map((f) => [f.category, JSON.parse(f.json) as Record<string, unknown>]),
    )
    for (const category of ['process', 'filament'] as const) {
      expect(byCategory[category].compatible_printers).toEqual(['Bambu Lab P1S 0.6 nozzle'])
    }
    // …and it is the machine file's `inherits` that the entry has to equal.
    expect(byCategory.machine.inherits).toBe('Bambu Lab P1S 0.6 nozzle')
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

describe('describeExportCompatibility', () => {
  it('passes a config that names a printer OrcaSlicer actually ships', () => {
    expect(describeExportCompatibility({ printer_model: 'Bambu Lab P1S', nozzle_diameter: 0.4 })).toBeNull()
  })

  it('flags a nozzle size no stock preset is named after', () => {
    // The derived "<model> 0.3 nozzle" names nothing, so machine.json's
    // `inherits` dangles and the bundle is rejected. Slicing here still works
    // — the engine takes any diameter — so this warns rather than blocking.
    const problem = describeExportCompatibility({ printer_model: 'Bambu Lab P1S', nozzle_diameter: 0.3 })
    expect(problem).toContain('0.3 mm nozzle')
  })

  it('flags a config with no derivable printer name at all', () => {
    // This one exports with neither `inherits` nor `compatible_printers`.
    // Verified against OrcaSlicer 2.4.2: that is rejected exactly like naming
    // the wrong printer (-17) — an absent list is not "compatible with any
    // printer" on the CLI path, so this can't be reported as a plain success.
    expect(describeExportCompatibility({ layer_height: 0.2 })).toContain('which printer model')
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

  it("does not let an imported profile's compatible_printers override the derived one", () => {
    // An imported profile carries the printer *it* was written for. Letting
    // that through means the exported bundle claims compatibility with a
    // printer its own machine.json isn't, and OrcaSlicer rejects the whole
    // combination ("process not compatible with printer", CLI exit -17) —
    // the exact failure the derived value exists to prevent. This is
    // reachable straight from the panel: import a vendor .json, hit Export.
    const imported = parseOrcaProfileJson(
      JSON.stringify({
        type: 'process',
        name: 'Some vendor 0.20mm Standard',
        layer_height: '0.2',
        compatible_printers: ['Creality Ender-3 0.4 nozzle'],
        compatible_printers_condition: 'nozzle_diameter[0]==0.4',
      }),
    )
    const json = exportOrcaProfileJson(
      { ...imported, printer_model: 'Bambu Lab P1S', nozzle_diameter: 0.4 },
      'p',
      'process',
    )
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.compatible_printers).toEqual(['Bambu Lab P1S 0.4 nozzle'])
    // Dropped rather than kept: it tests the printer the import came from, so
    // it can reject the combination on its own even with the list corrected.
    expect(parsed.compatible_printers_condition).toBeUndefined()
  })

  it("keeps an imported profile's printable_area, restored to the array form real profiles use", () => {
    // Deliberately the one passthrough field that outranks a derived value —
    // it's how a non-rectangular or offset bed survives import -> export,
    // where bed_size_x/y can only describe a rectangle.
    const imported = parseOrcaProfileJson(
      JSON.stringify({ type: 'machine', printable_area: ['10x10', '210x10', '210x210', '10x210'] }),
    )
    const json = exportOrcaProfileJson({ ...imported, bed_size_x: 256, bed_size_y: 256 }, 'p', 'machine')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.printable_area).toEqual(['10x10', '210x10', '210x210', '10x210'])
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

describe('parseOrcaProfileJson multi-value options (#140)', () => {
  // A real Bambu Lab H2D: two nozzles, one printable area per nozzle.
  const H2D = {
    nozzle_diameter: ['0.4', '0.4'],
    extruder_printable_area: ['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320'],
    filament_type: ['PLA', 'PETG'],
    single_valued_field: ['0.8'],
    scalar_field: 'plain',
  }

  it('keeps multi-value options as arrays so the bridge can pick the right separator', () => {
    const pt = parseOrcaProfileJson(JSON.stringify(H2D))._passthrough
    // Joining these in JS is what used to fuse a dual-nozzle machine's two
    // printable areas into one 8-point group and crash the brim generator.
    expect(pt?.extruder_printable_area).toEqual(['0x0,325x0,325x320,0x320', '25x0,350x0,350x320,25x320'])
    expect(pt?.filament_type).toEqual(['PLA', 'PETG'])
  })

  it('forwards multi-value fields that are also UI-mapped, which the scalar mapping would flatten', () => {
    const parsed = parseOrcaProfileJson(JSON.stringify(H2D))
    // The UI keeps a single number...
    expect(parsed.nozzle_diameter).toBe(0.4)
    // ...but the engine must still see both nozzles, or it slices a
    // dual-nozzle machine as if it had one.
    expect(parsed._passthrough?.nozzle_diameter).toEqual(['0.4', '0.4'])
  })

  it('does not pass single-valued mapped fields through twice', () => {
    const pt = parseOrcaProfileJson(JSON.stringify({ nozzle_diameter: ['0.4'] }))._passthrough
    expect(pt?.nozzle_diameter).toBeUndefined()
  })

  it('still collapses single-entry arrays and leaves scalars alone', () => {
    const pt = parseOrcaProfileJson(JSON.stringify(H2D))._passthrough
    expect(pt?.single_valued_field).toBe('0.8')
    expect(pt?.scalar_field).toBe('plain')
  })

  it('no longer drops a multi-nozzle profile wholesale', () => {
    // This used to return an empty passthrough: multi-extruder profiles were
    // rejected outright because they crashed the engine.
    const pt = parseOrcaProfileJson(JSON.stringify(H2D))._passthrough
    expect(pt && Object.keys(pt).length).toBeGreaterThan(0)
  })
})

describe('withFilamentSlots (#140)', () => {
  const singleNozzle: OrcaConfig = {}
  // A real dual-nozzle machine, as an imported profile leaves it in the config.
  const dualNozzle: OrcaConfig = { _passthrough: { nozzle_diameter: ['0.4', '0.4'] } }

  it('leaves a one-slot config completely untouched', () => {
    expect(withFilamentSlots(singleNozzle, ['PLA'])).toBe(singleNozzle)
  })

  it('ignores slots naming a material that does not exist', () => {
    expect(withFilamentSlots(singleNozzle, ['PLA', 'Unobtainium'])).toBe(singleNozzle)
  })

  it('gives the engine one colour per slot — that is what it counts filaments by', () => {
    const pt = withFilamentSlots(singleNozzle, ['PLA', 'PETG', 'ABS'])._passthrough
    expect(pt?.filament_colour).toHaveLength(3)
    expect(new Set(pt?.filament_colour as string[]).size).toBe(3)
    expect(pt?.filament_type).toEqual(['PLA', 'PETG', 'ABS'])
  })

  it('keeps every slot on the single nozzle of an AMS-style printer', () => {
    const pt = withFilamentSlots(singleNozzle, ['PLA', 'PETG', 'ABS', 'TPU'])._passthrough
    expect(pt?.filament_map).toEqual(['1', '1', '1', '1'])
    // one nozzle x 4 filaments squared
    expect(pt?.flush_volumes_matrix).toHaveLength(16)
    expect(pt?.flush_multiplier).toEqual(['1'])
  })

  it('alternates slots across the nozzles of a real multi-nozzle machine', () => {
    const pt = withFilamentSlots(dualNozzle, ['PLA', 'PETG'])._passthrough
    // this is what produces genuine T0/T1 tool changes
    expect(pt?.filament_map).toEqual(['1', '2'])
    // two nozzles x 2 filaments squared, and one multiplier per nozzle —
    // the engine rejects any other length outright
    expect(pt?.flush_volumes_matrix).toHaveLength(8)
    expect(pt?.flush_multiplier).toEqual(['1', '1'])
  })

  it('purges nothing into the same filament and something into a different one', () => {
    const m = withFilamentSlots(singleNozzle, ['PLA', 'PETG'])._passthrough?.flush_volumes_matrix as string[]
    expect(m[0]).toBe('0') // slot 1 -> slot 1
    expect(Number(m[1])).toBeGreaterThan(0) // slot 1 -> slot 2
    expect(m[3]).toBe('0') // slot 2 -> slot 2
  })

  it('sizes the per-filament G-code hooks, so a slot other than the first can print', () => {
    // The engine reads these with .at(filament_id); leaving them at their
    // one-entry default made assigning an object to slot 2 throw.
    const pt = withFilamentSlots(singleNozzle, ['PLA', 'PETG', 'ABS'])._passthrough
    expect(pt?.filament_start_gcode).toHaveLength(3)
    expect(pt?.filament_end_gcode).toHaveLength(3)
  })

  it('preserves passthrough the profile already had', () => {
    const withGcode: OrcaConfig = { _passthrough: { machine_start_gcode: 'G28' } }
    const pt = withFilamentSlots(withGcode, ['PLA', 'PETG'])._passthrough
    expect(pt?.machine_start_gcode).toBe('G28')
    expect(pt?.filament_colour).toHaveLength(2)
  })

  it('offers a slot for every colour it can assign', () => {
    const pt = withFilamentSlots(singleNozzle, Array(MAX_FILAMENT_SLOTS).fill('PLA'))._passthrough
    expect(new Set(pt?.filament_colour as string[]).size).toBe(MAX_FILAMENT_SLOTS)
  })
})
