import { describe, expect, it } from 'vitest'
import { mergeConfigLayers, overriddenFields, resolveConfig, revertField } from './config-layers'

describe('resolveConfig', () => {
  it('shows the preset selection when nothing else sets a field', () => {
    expect(resolveConfig({ preset: { skirt_loops: 3 } }).skirt_loops).toBe(3)
  })

  it('lets an imported file outrank the preset selection', () => {
    expect(resolveConfig({ preset: { skirt_loops: 3 }, imported: { skirt_loops: 2 } }).skirt_loops).toBe(2)
  })

  it('lets a manual edit outrank both', () => {
    const config = resolveConfig({
      preset: { skirt_loops: 3 },
      imported: { skirt_loops: 2 },
      manual: { skirt_loops: 0 },
    })
    expect(config.skirt_loops).toBe(0)
  })

  it('keeps a manual 0 rather than falling through to a lower layer', () => {
    // 0 is a meaningful value for several fields (skirt loops, brim width,
    // raft layers) and the one most likely to be lost to a truthiness check.
    expect(resolveConfig({ preset: { brim_width: 5 }, manual: { brim_width: 0 } }).brim_width).toBe(0)
  })

  it('survives swapping the layers underneath it', () => {
    const manual = { skirt_loops: 0 }
    const before = resolveConfig({ preset: { skirt_loops: 3, layer_height: 0.2 }, manual })
    const after = resolveConfig({ preset: { skirt_loops: 1, layer_height: 0.12 }, manual })
    expect(before.skirt_loops).toBe(0)
    expect(after.skirt_loops).toBe(0)
    // Everything the user did NOT touch does follow the new preset.
    expect(after.layer_height).toBe(0.12)
  })
})

describe('mergeConfigLayers', () => {
  it('merges _passthrough across layers instead of replacing it', () => {
    const merged = mergeConfigLayers(
      { _passthrough: { machine_start_gcode: 'G28' } },
      { _passthrough: { filament_flow_ratio: '0.98' } },
    )
    expect(merged._passthrough).toEqual({ machine_start_gcode: 'G28', filament_flow_ratio: '0.98' })
  })

  it('omits _passthrough entirely when no layer has one', () => {
    expect(mergeConfigLayers({ layer_height: 0.2 }, {})).not.toHaveProperty('_passthrough')
  })
})

describe('overriddenFields', () => {
  it('lists the manually edited fields', () => {
    expect(overriddenFields({ skirt_loops: 0, brim_type: 'no_brim' })).toEqual(['skirt_loops', 'brim_type'])
  })

  it('does not treat _passthrough as an overridden field', () => {
    expect(overriddenFields({ _passthrough: { foo: '1' } })).toEqual([])
  })
})

describe('revertField', () => {
  it('drops only the named field', () => {
    expect(revertField({ skirt_loops: 0, brim_type: 'no_brim' }, 'skirt_loops')).toEqual({ brim_type: 'no_brim' })
  })

  it('reveals the layer below once reverted', () => {
    const manual = revertField({ skirt_loops: 0 }, 'skirt_loops')
    expect(resolveConfig({ preset: { skirt_loops: 3 }, manual }).skirt_loops).toBe(3)
  })
})
