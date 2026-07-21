import { describe, expect, it } from 'vitest'
import type { OrcaConfig } from '../types'
import { exportOrcaProfileJson, filamentSlots, parseOrcaProfileJson } from './profiles'

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

describe('exportOrcaProfileJson', () => {
  it('round-trips known fields through parseOrcaProfileJson', () => {
    const config: OrcaConfig = {
      layer_height: 0.16,
      initial_layer_height: 0.2,
      wall_loops: 4,
      top_shell_layers: 5,
      bottom_shell_layers: 3,
      sparse_infill_density: 20,
      sparse_infill_pattern: 'gyroid',
      nozzle_diameter: 0.6,
      nozzle_temperature: 230,
      bed_temperature: 65,
      enable_support: true,
      support_type: 'tree(auto)',
      brim_width: 5,
      brim_type: 'outer_and_inner',
      skirt_loops: 2,
      skirt_distance: 3,
      raft_layers: 4,
      bed_size_x: 220,
      bed_size_y: 220,
    }

    const json = exportOrcaProfileJson(config, 'test profile')
    const reimported = parseOrcaProfileJson(json)

    expect(reimported).toMatchObject(config)
  })

  it('writes percentages back in OrcaSlicer\'s "NN%" format', () => {
    const json = exportOrcaProfileJson({ sparse_infill_density: 33 }, 'p')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.sparse_infill_density).toBe('33%')
  })

  it('passes _passthrough fields through verbatim', () => {
    const json = exportOrcaProfileJson({ _passthrough: { some_unmapped_field: '42' } }, 'p')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.some_unmapped_field).toBe('42')
  })

  it('writes the real OrcaSlicer field names for default_speed/enable_ironing, not the synthetic OrcaConfig-only ones', () => {
    // Round-tripping through this app's own parseOrcaProfileJson can't catch
    // a wrong field name here — it recognizes both the real and synthetic
    // names — so this asserts the raw JSON keys directly, matching what a
    // real desktop OrcaSlicer install (which only recognizes the real names)
    // would actually see.
    const json = exportOrcaProfileJson({ default_speed: 120, enable_ironing: true }, 'p')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.inner_wall_speed).toBe('120')
    expect(parsed.ironing).toBe('1')
    expect(parsed.default_speed).toBeUndefined()
    expect(parsed.enable_ironing).toBeUndefined()
  })
})
