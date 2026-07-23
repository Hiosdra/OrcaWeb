import { describe, expect, it } from 'vitest'
import type { OrcaConfig, PassthroughConfig } from '../types'
import {
  buildConfig,
  describeExportCompatibility,
  exportOrcaProfileBundle,
  exportOrcaProfileJson,
  filamentSlotLabels,
  filamentSlots,
  flattenSliceConfig,
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

  it('keeps a single filament.json for a single-slot config', () => {
    const bundle = exportOrcaProfileBundle(config, 'test')
    const filaments = bundle.filter((f) => f.category === 'filament')
    expect(filaments.map((f) => f.filename)).toEqual(['filament.json'])
  })
})

describe('exportOrcaProfileBundle multi-material (#162)', () => {
  // The reproduction from the issue: a 2-slot PLA/PETG config. Before the fix
  // this produced ONE filament.json whose filament_type/colour/temperature were
  // per-slot arrays, which desktop OrcaSlicer reads back as a single filament.
  const config = withFilamentSlots(buildConfig('Bambu Lab P1S', ['PLA', 'PETG'], 'standard'), ['PLA', 'PETG'])

  it('emits one single-material filament file per slot', () => {
    const bundle = exportOrcaProfileBundle(config, 'test')
    const filaments = bundle
      .filter((f) => f.category === 'filament')
      .map((f) => ({ filename: f.filename, json: JSON.parse(f.json) as Record<string, unknown> }))

    expect(filaments.map((f) => f.filename)).toEqual(['filament-1.json', 'filament-2.json'])
    // Each file names its own single material — a scalar, not the array that
    // collapses back to one filament on load.
    expect(filaments[0].json.filament_type).toBe('PLA')
    expect(filaments[1].json.filament_type).toBe('PETG')
    for (const f of filaments) {
      expect(Array.isArray(f.json.filament_type)).toBe(false)
      expect(Array.isArray(f.json.filament_colour)).toBe(false)
      expect(Array.isArray(f.json.nozzle_temperature)).toBe(false)
    }
    // Slots differ, so the flattened per-slot temperatures must too.
    expect(filaments[0].json.nozzle_temperature).not.toBe(filaments[1].json.nozzle_temperature)
    expect(filaments[0].json.filament_colour).not.toBe(filaments[1].json.filament_colour)
  })

  it('keeps the machine-level multi-material options in machine.json only', () => {
    const bundle = exportOrcaProfileBundle(config, 'test')
    const byCategory = (cat: string) =>
      bundle.filter((f) => f.category === cat).map((f) => JSON.parse(f.json) as Record<string, unknown>)

    const machine = byCategory('machine')[0]
    expect(machine.filament_map).toBeDefined()
    expect(machine.flush_volumes_matrix).toBeDefined()
    expect(machine.flush_multiplier).toBeDefined()
    expect(machine.filament_map_mode).toBe('Manual')

    for (const file of [...byCategory('filament'), ...byCategory('process')]) {
      expect(file.filament_map).toBeUndefined()
      expect(file.flush_volumes_matrix).toBeUndefined()
      expect(file.flush_multiplier).toBeUndefined()
      expect(file.filament_map_mode).toBeUndefined()
    }
  })

  it('indexes every per-slot vector — including ones this app never names — to its own slot', () => {
    // An imported multi-material profile carries per-filament vectors with no UI
    // here (flow ratio, max volumetric speed). Each filament file must take its
    // own slot's entry, not all read slot 0's.
    const imported: OrcaConfig = {
      ...config,
      _passthrough: {
        ...config._passthrough,
        filament_flow_ratio: ['0.98', '0.95'],
        filament_max_volumetric_speed: ['21', '12'],
      },
    }
    const filaments = exportOrcaProfileBundle(imported, 'test')
      .filter((f) => f.category === 'filament')
      .map((f) => JSON.parse(f.json) as Record<string, unknown>)

    expect(filaments[0].filament_flow_ratio).toBe('0.98')
    expect(filaments[1].filament_flow_ratio).toBe('0.95')
    expect(filaments[0].filament_max_volumetric_speed).toBe('21')
    expect(filaments[1].filament_max_volumetric_speed).toBe('12')
  })

  it('keeps a per-nozzle nozzle_diameter in machine.json only, un-sliced (review #165)', () => {
    // A multi-nozzle import carries nozzle_diameter as a per-NOZZLE vector (an
    // H2D has two), round-robin-mapped to slots — it is NOT a per-slot vector.
    // It must not be sliced by slot index into each filament file; it belongs
    // to machine.json as the full array.
    const imported: OrcaConfig = {
      ...config,
      _passthrough: { ...config._passthrough, nozzle_diameter: ['0.4', '0.4'] },
    }
    const byCategory = (cat: string) =>
      exportOrcaProfileBundle(imported, 'test')
        .filter((f) => f.category === cat)
        .map((f) => JSON.parse(f.json) as Record<string, unknown>)

    for (const file of [...byCategory('filament'), ...byCategory('process')]) {
      expect(file.nozzle_diameter).toBeUndefined()
    }
    expect(byCategory('machine')[0].nozzle_diameter).toEqual(['0.4', '0.4'])
  })

  it('names the compatible printer on every per-slot filament file', () => {
    const filaments = exportOrcaProfileBundle(config, 'test')
      .filter((f) => f.category === 'filament')
      .map((f) => JSON.parse(f.json) as Record<string, unknown>)
    for (const f of filaments) {
      expect(f.compatible_printers).toEqual(['Bambu Lab P1S 0.4 nozzle'])
    }
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

  it('round-trips the prime-tower fields through their real OrcaSlicer names (#163)', () => {
    // Modeled (not passthrough) so the panel toggle/width drive them, which
    // means they need a real export name and a matching parse — otherwise a
    // saved profile would silently drop the tower, the same class of bug as
    // the synthetic keys above.
    const json = exportOrcaProfileJson({ enable_prime_tower: true, prime_tower_width: 48 }, 'p', 'process')
    const raw = JSON.parse(json) as Record<string, unknown>
    expect(raw.enable_prime_tower).toBe('1')
    expect(raw.prime_tower_width).toBe('48')
    const parsed = parseOrcaProfileJson(json)
    expect(parsed.enable_prime_tower).toBe(true)
    expect(parsed.prime_tower_width).toBe(48)
  })

  it('parses a prime tower explicitly turned off', () => {
    const parsed = parseOrcaProfileJson(JSON.stringify({ enable_prime_tower: '0' }))
    expect(parsed.enable_prime_tower).toBe(false)
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

  it('drops a single empty entry, exactly as the old comma-join did', () => {
    // Leaf profiles carry [""] for every option they inherit rather than
    // override. buildConfig() merges _passthrough field by field with later
    // layers winning, so storing "" lets an import blank out the built-in
    // preset's value for that key.
    const pt = parseOrcaProfileJson(JSON.stringify({ empty_field: [''], kept_field: ['x'] }))._passthrough
    expect(pt?.empty_field).toBeUndefined()
    expect(pt?.kept_field).toBe('x')
  })

  it('keeps the empties in a multi-entry array, where the length is load-bearing', () => {
    // filament_start_gcode: ["", ""] is what sizes the vector the engine reads
    // with .at(filament_id) — dropping it is an out-of-range read, not a tidy-up.
    const pt = parseOrcaProfileJson(JSON.stringify({ filament_start_gcode: ['', ''] }))._passthrough
    expect(pt?.filament_start_gcode).toEqual(['', ''])
  })

  it('keeps a lone value the collapse to a plain string would corrupt', () => {
    // A coStrings option forwarded as an *array* goes through the bridge's
    // escape_strings_cstyle(), which quotes any element containing ';'.
    // Collapsed to a bare string it reaches unescape_strings_cstyle() unquoted
    // and is split on every ';' — so a filament_start_gcode with a "; comment"
    // line arrives chopped in two, with only the first fragment ever run.
    // The array form is never less correct, so anything a quoting pass would
    // have had to touch stays an array. See collapsesCleanly().
    const pt = parseOrcaProfileJson(
      JSON.stringify({
        filament_start_gcode: ['M900 K0.02 ; set pressure advance'],
        multiline_gcode: ['G28\n; home first'],
        quoted_field: ['"already quoted"'],
        leading_space: [' indented'],
      }),
    )._passthrough
    expect(pt?.filament_start_gcode).toEqual(['M900 K0.02 ; set pressure advance'])
    expect(pt?.multiline_gcode).toEqual(['G28\n; home first'])
    expect(pt?.quoted_field).toEqual(['"already quoted"'])
    expect(pt?.leading_space).toEqual([' indented'])
  })

  it('still collapses a lone value that survives the round trip, spaces and all', () => {
    // The control for the test above: only the shapes the engine would re-read
    // differently keep the array form, so ordinary single-extruder fields are
    // not churned into arrays across every import and export.
    const pt = parseOrcaProfileJson(
      JSON.stringify({ plain_field: ['0.8'], spaced_field: ['normal(auto) tree'], gcode_no_comment: ['G28\nG1 Z5'] }),
    )._passthrough
    expect(pt?.plain_field).toBe('0.8')
    expect(pt?.spaced_field).toBe('normal(auto) tree')
    expect(pt?.gcode_no_comment).toBe('G28\nG1 Z5')
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

  it('turns the prime tower on for a multi-slot config — the engine default is off (#163)', () => {
    // #160 configures the flush volumes; without a tower the purge they
    // describe has nowhere to go, and OrcaSlicer defaults enable_prime_tower
    // off, so withFilamentSlots has to turn it on.
    expect(withFilamentSlots(singleNozzle, ['PLA', 'PETG'])._passthrough?.enable_prime_tower).toBe('1')
  })

  it('gives the prime tower the addressing + reset the engine hard-requires (#163)', () => {
    // Print::validate() rejects a wipe tower unless use_relative_e_distances=1,
    // and rejects relative addressing on a Marlin/non-Bambu printer unless the
    // layer-change G-code resets the extruder. Both must ride along with the
    // tower or the slice fails validation outright.
    const pt = withFilamentSlots(singleNozzle, ['PLA', 'PETG'])._passthrough
    expect(pt?.use_relative_e_distances).toBe('1')
    expect(pt?.before_layer_change_gcode).toMatch(/^[ \t]*G92[ \t]*E0/m)
  })

  it('appends the E-reset to a profile’s existing layer G-code instead of dropping it', () => {
    const withLayerGcode: OrcaConfig = { _passthrough: { before_layer_change_gcode: '; my layer hook' } }
    const g = withFilamentSlots(withLayerGcode, ['PLA', 'PETG'])._passthrough?.before_layer_change_gcode as string
    expect(g).toContain('; my layer hook')
    expect(g).toMatch(/^[ \t]*G92[ \t]*E0/m)
  })

  it('does not duplicate an E-reset a profile already has', () => {
    const already: OrcaConfig = { _passthrough: { before_layer_change_gcode: ';[layer_z]\nG92 E0\n' } }
    const g = withFilamentSlots(already, ['PLA', 'PETG'])._passthrough?.before_layer_change_gcode as string
    expect(g.match(/G92 E0/g)).toHaveLength(1)
  })

  it('honours an explicit prime-tower-off choice over the multi-slot default', () => {
    const off: OrcaConfig = { enable_prime_tower: false }
    const pt = withFilamentSlots(off, ['PLA', 'PETG'])._passthrough
    expect(pt?.enable_prime_tower).toBe('0')
    // With no tower there is nothing forcing relative addressing, so the plate
    // keeps slicing under the bridge's absolute-addressing default as before.
    expect(pt?.use_relative_e_distances).toBeUndefined()
    expect(pt?.before_layer_change_gcode).toBeUndefined()
  })

  it('honours a prime-tower setting an older import left in passthrough', () => {
    const imported: OrcaConfig = { _passthrough: { enable_prime_tower: '0' } }
    expect(withFilamentSlots(imported, ['PLA', 'PETG'])._passthrough?.enable_prime_tower).toBe('0')
  })

  it('never adds a prime tower to a one-slot config — there is no tool change to purge on', () => {
    expect(withFilamentSlots(singleNozzle, ['PLA'])._passthrough?.enable_prime_tower).toBeUndefined()
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

  it('keeps slot 0 on the resolved config, not the stock preset for its material', () => {
    // These arrays land in _passthrough, which the worker spreads *over* the
    // resolved config — so reading FILAMENT_PRESETS for slot 0 is a silent way
    // to revert a manual override the moment a second slot is added.
    const edited: OrcaConfig = { filament_type: 'PLA', nozzle_temperature: 250, bed_temperature: 80 }
    const pt = withFilamentSlots(edited, ['PLA', 'PETG'])._passthrough as PassthroughConfig
    expect(pt.nozzle_temperature[0]).toBe('250')
    expect(pt.hot_plate_temp[0]).toBe('80')
    expect(pt.hot_plate_temp_initial_layer[0]).toBe('80')
    // Slot 1 has no UI of its own, so it still takes PETG's preset values.
    expect(pt.nozzle_temperature[1]).not.toBe('250')
  })

  it('pads an existing filament start G-code across the new slots instead of blanking it', () => {
    const withHook: OrcaConfig = { _passthrough: { filament_start_gcode: 'M900 K0.02' } }
    const pt = withFilamentSlots(withHook, ['PLA', 'PETG'])._passthrough
    expect(pt?.filament_start_gcode).toEqual(['M900 K0.02', 'M900 K0.02'])
  })

  it('sizes the per-filament vectors for slots an imported profile declares on its own', () => {
    // A multi-material profile arrives with more filaments than the UI has
    // slots for. The queue's picker offers them, so they need the same
    // vectors — sizing only the UI's one slot is the .at(filament_id) throw.
    const imported: OrcaConfig = { _passthrough: { filament_type: ['PLA', 'PETG'] } }
    const pt = withFilamentSlots(imported, ['PLA'])._passthrough
    expect(pt?.filament_colour).toHaveLength(2)
    expect(pt?.filament_start_gcode).toHaveLength(2)
    expect(pt?.flush_volumes_matrix).toHaveLength(4)
    expect(pt?.filament_type).toEqual(['PLA', 'PETG'])
  })

  it('emits exactly the option set orca-wasm/scripts/smoke-test.mjs slices with', () => {
    // DUAL_NOZZLE_CONFIG in the smoke test is a hand-written copy of what this
    // function produces — it has to be, since a node script cannot import the
    // TS module. That makes it the one thing in this PR that can drift: the
    // smoke test would keep proving T0/T1 for a config the app no longer
    // builds. Pin the contract between them here, where both are visible.
    const pt = withFilamentSlots(dualNozzle, ['PLA', 'PETG'])._passthrough as PassthroughConfig
    expect(Object.keys(pt).sort()).toEqual(
      [
        'before_layer_change_gcode',
        'enable_prime_tower',
        'filament_colour',
        'filament_diameter',
        'filament_end_gcode',
        'filament_map',
        'filament_map_mode',
        'filament_start_gcode',
        'filament_type',
        'flush_multiplier',
        'flush_volumes_matrix',
        'hot_plate_temp',
        'hot_plate_temp_initial_layer',
        'nozzle_diameter',
        'nozzle_temperature',
        'nozzle_temperature_initial_layer',
        'use_relative_e_distances',
      ].sort(),
    )
    // Every filament-indexed vector is N long; the engine reads them by
    // filament id and a short one is read out of bounds.
    for (const key of [
      'filament_type',
      'filament_colour',
      'filament_diameter',
      'nozzle_temperature',
      'nozzle_temperature_initial_layer',
      'hot_plate_temp',
      'hot_plate_temp_initial_layer',
      'filament_start_gcode',
      'filament_end_gcode',
      'filament_map',
    ]) {
      expect(pt[key], key).toHaveLength(2)
    }
    // The three the engine validates by shape rather than by index: one N x N
    // sub-matrix per nozzle, one multiplier per nozzle, slots alternating
    // across the two nozzles (which is what produces T0 and T1).
    expect(pt.flush_volumes_matrix).toEqual(['0', '280', '280', '0', '0', '280', '280', '0'])
    expect(pt.flush_multiplier).toEqual(['1', '1'])
    expect(pt.filament_map).toEqual(['1', '2'])
    expect(pt.filament_map_mode).toBe('Manual')
  })
})

describe('withFilamentSlots on an imported multi-material profile', () => {
  // How a dual-material profile actually reaches us: every per-filament option
  // as an array, and the UI-mapped ones (filament_type, nozzle_temperature,
  // hot_plate_temp) additionally collapsed to a scalar for display.
  const imported = () =>
    parseOrcaProfileJson(
      JSON.stringify({
        filament_type: ['PLA', 'PETG'],
        filament_colour: ['#FF0000', '#00FF00'],
        filament_diameter: ['2.85', '2.85'],
        nozzle_temperature: ['215', '255'],
        nozzle_temperature_initial_layer: ['210', '250'],
        hot_plate_temp: ['55', '80'],
        flush_volumes_matrix: ['0', '700', '700', '0'],
      }),
    ) as OrcaConfig

  it('does not name slot 0 after the flattened scalar', () => {
    // config.filament_type is ORCA_FIELD_MAP's display collapse of the array —
    // the joined "PLA,PETG". Reading it verbatim gave the engine that literal
    // string as slot 1's type, and the queue's picker "Slot 1 · PLA,PETG".
    const config = imported()
    expect(config.filament_type).toBe('PLA,PETG')
    const pt = withFilamentSlots(config, ['PLA'])._passthrough
    expect(pt?.filament_type).toEqual(['PLA', 'PETG'])
    expect(filamentSlotLabels(withFilamentSlots(config, ['PLA']))).toEqual(['PLA', 'PETG'])
  })

  it('keeps the values the profile declared instead of regenerating them', () => {
    // _passthrough is spread *over* the resolved config, so deriving these
    // from a stock preset silently replaces what the user imported — the same
    // bug slot 0 had for temperatures, one slot further down the list.
    const pt = withFilamentSlots(imported(), ['PLA'])._passthrough
    expect(pt?.filament_colour).toEqual(['#FF0000', '#00FF00'])
    expect(pt?.filament_diameter).toEqual(['2.85', '2.85'])
    expect(pt?.nozzle_temperature).toEqual(['215', '255'])
    expect(pt?.hot_plate_temp).toEqual(['55', '80'])
    expect(pt?.flush_volumes_matrix).toEqual(['0', '700', '700', '0'])
  })

  it('keeps a declared nozzle initial-layer temperature, which has no UI of its own', () => {
    // toEngineConfig() never writes nozzle_temperature_initial_layer, so no
    // panel value can contradict the imported one. Its bed counterpart is the
    // opposite case — see the next test.
    const pt = withFilamentSlots(imported(), ['PLA'])._passthrough
    expect(pt?.nozzle_temperature_initial_layer).toEqual(['210', '250'])
  })

  it('lets the panel drive the first-layer bed temperature, which it edits through the same knob', () => {
    // toEngineConfig() fans the panel's single "Bed temp" field out to *both*
    // hot_plate_temp and hot_plate_temp_initial_layer, so a declared
    // first-layer value must not outrank it for slot 0 — a single-slot config
    // puts the typed number in both, and adding a slot silently left the first
    // layer on the import's temperature while the panel showed the new one.
    const declaresBoth = {
      ...imported(),
      _passthrough: { ...imported()._passthrough, hot_plate_temp_initial_layer: ['55', '80'] },
    } as OrcaConfig
    const pt = withFilamentSlots({ ...declaresBoth, bed_temperature: 60 }, ['PLA'])._passthrough
    expect(pt?.hot_plate_temp).toEqual(['60', '80'])
    expect(pt?.hot_plate_temp_initial_layer).toEqual(['60', '80'])
  })

  it('still lets a manual override win for slot 0', () => {
    // The panel edits slot 0, so its resolved value outranks the imported
    // layer — otherwise adding a slot reverts a hand-typed temperature (#159).
    const edited: OrcaConfig = { ...imported(), nozzle_temperature: 230, bed_temperature: 90 }
    const pt = withFilamentSlots(edited, ['PLA'])._passthrough
    expect(pt?.nozzle_temperature).toEqual(['230', '255'])
    expect(pt?.hot_plate_temp).toEqual(['90', '80'])
  })

  it('lets a slot the UI names win over what the profile said about it', () => {
    // The user picked ABS for slot 2 in the panel; an older import saying
    // PETG does not get to override that.
    const pt = withFilamentSlots(imported(), ['PLA', 'ABS'])._passthrough
    expect(pt?.filament_type).toEqual(['PLA', 'ABS'])
    expect(pt?.nozzle_temperature?.[1]).not.toBe('255')
  })

  it('keeps a declared filament diameter for a slot the UI names, which has no diameter to offer', () => {
    // The "UI slot wins" rule is only sound for options read off the picked
    // material's preset. No FILAMENT_PRESETS entry carries a diameter, so
    // routing this through per() could only ever replace an imported 2.85 mm
    // with the stock 1.75 — silently, and off by (2.85/1.75)^2 in every E value.
    expect(withFilamentSlots(imported(), ['PLA'])._passthrough?.filament_diameter).toEqual(['2.85', '2.85'])
    expect(withFilamentSlots(imported(), ['PLA', 'ABS'])._passthrough?.filament_diameter).toEqual(['2.85', '2.85'])
    // Nothing declared: the engine's own PrintConfig.cpp default, per slot.
    expect(withFilamentSlots({}, ['PLA', 'ABS'])._passthrough?.filament_diameter).toEqual(['1.75', '1.75'])
  })

  it('discards a declared flush matrix that is the wrong shape for this machine', () => {
    // append_full_config() rejects any length but nozzles x N^2 outright, so a
    // matrix sized for the profile's own filament count cannot be kept.
    const config: OrcaConfig = {
      _passthrough: { filament_type: ['PLA', 'PETG'], flush_volumes_matrix: ['0', '700', '700'] },
    }
    expect(withFilamentSlots(config, ['PLA'])._passthrough?.flush_volumes_matrix).toEqual(['0', '280', '280', '0'])
  })

  it('honours a declared filament_map, but only when it names nozzles this machine has', () => {
    const dual: PassthroughConfig = { nozzle_diameter: ['0.4', '0.4'], filament_type: ['PLA', 'PETG'] }
    expect(
      withFilamentSlots({ _passthrough: { ...dual, filament_map: ['2', '1'] } }, ['PLA'])._passthrough?.filament_map,
    ).toEqual(['2', '1'])
    // A map carried over from a 3-nozzle machine would have the engine index
    // an extruder this one does not have — fall back to round-robin.
    expect(
      withFilamentSlots({ _passthrough: { ...dual, filament_map: ['1', '3'] } }, ['PLA'])._passthrough?.filament_map,
    ).toEqual(['1', '2'])
  })

  it('gives slots past the colour palette distinct colours rather than repeating it', () => {
    const many = Array.from({ length: MAX_FILAMENT_SLOTS + 3 }, (_, i) => `PLA${i}`)
    const config: OrcaConfig = { _passthrough: { filament_type: many } }
    const colours = withFilamentSlots(config, ['PLA'])._passthrough?.filament_colour as string[]
    expect(colours).toHaveLength(many.length)
    expect(new Set(colours).size).toBe(many.length)
    expect(colours.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true)
  })
})

describe('filamentSlotLabels', () => {
  it('falls back to the display text for a single-slot config', () => {
    expect(filamentSlotLabels({ filament_type: 'PLA' })).toEqual(['PLA'])
  })

  it('lists one label per real slot once the config declares several', () => {
    const config = withFilamentSlots({ filament_type: 'PLA' }, ['PLA', 'PETG', 'ABS'])
    expect(filamentSlotLabels(config)).toEqual(['PLA', 'PETG', 'ABS'])
  })

  it('agrees with the count withFilamentSlots actually sized', () => {
    // The queue drops assignments above this number, so a disagreement here
    // either strands a valid slot or lets an out-of-range one through.
    const config = withFilamentSlots({ _passthrough: { filament_type: ['PLA', 'PETG'] } }, ['PLA'])
    const colours = (config._passthrough as PassthroughConfig).filament_colour
    expect(filamentSlotLabels(config)).toHaveLength(colours.length)
  })

  it('does not turn a joined display scalar into slots nothing sized', () => {
    // filamentSlots() splits filament_type on [;,] for display, and a profile
    // can carry "PLA;PETG" there with no per-slot array behind it. Both this
    // and withFilamentSlots() read declaredSlotCount(), which sees one slot —
    // so withFilamentSlots() returns early and sizes no per-filament vectors.
    // Offering a second label here would put a Slot 2 in the picker whose
    // extruderId indexes a one-filament config.
    const joined: OrcaConfig = { filament_type: 'PLA;PETG' }
    expect(withFilamentSlots(joined, ['PLA'])).toBe(joined) // nothing sized
    expect(filamentSlotLabels(joined)).toEqual(['PLA'])
    expect(filamentSlotLabels({ filament_type: 'PLA,PETG' })).toEqual(['PLA'])
  })

  it('still lists both once the per-slot array is actually there', () => {
    // The control: a real import carries the array, declaredSlotCount() sees
    // two, and withFilamentSlots() sizes for two — so both are offered.
    const imported = withFilamentSlots({ _passthrough: { filament_type: ['PLA', 'PETG'] } }, ['PLA'])
    expect(filamentSlotLabels(imported)).toEqual(['PLA', 'PETG'])
  })
})

describe('flattenSliceConfig (#163 single-object slice path)', () => {
  // A multi-material config as withFilamentSlots would produce it: the tower is
  // on and its flag lives in _passthrough as the engine string '1'.
  const multiMaterial = withFilamentSlots({ bed_size_x: 250, bed_size_y: 210 }, ['PLA', 'PETG'])

  it('merges _passthrough over the modeled config, _passthrough winning', () => {
    const flat = flattenSliceConfig({ layer_height: 0.2, _passthrough: { layer_height: '0.3' } }, true)
    expect(flat.layer_height).toBe('0.3')
  })

  it('keeps the prime tower for a slice that carries a filament slot (orc_slice_multi clamps it)', () => {
    expect(multiMaterial._passthrough?.enable_prime_tower).toBe('1')
    expect(flattenSliceConfig(multiMaterial, true).enable_prime_tower).toBe('1')
  })

  it('forces the prime tower off for a no-slot single object (orc_slice never clamps it)', () => {
    // The bug: this object prints with the default filament through orc_slice,
    // which skips clamp_wipe_tower_to_bed — a leftover enable_prime_tower would
    // build an unclamped, off-bed tower (#163's own bug via another call site).
    expect(flattenSliceConfig(multiMaterial, false).enable_prime_tower).toBe('0')
  })

  it('leaves a single-material config alone (no tower flag either way)', () => {
    expect(flattenSliceConfig({ layer_height: 0.2 }, false).enable_prime_tower).toBe('0')
    expect(flattenSliceConfig({ layer_height: 0.2 }, true).enable_prime_tower).toBeUndefined()
  })
})
