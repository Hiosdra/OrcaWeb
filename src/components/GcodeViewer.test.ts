import { describe, expect, it } from 'vitest'
import { parseGcode } from './GcodeViewer'

const parsedSegments = (gcode: string) => {
  const layer = parseGcode(gcode).layers[0]
  return {
    extrusion: layer?.features.reduce((count, feature) => count + feature.segments.length / 6, 0) ?? 0,
    travel: (layer?.travels.length ?? 0) / 6,
  }
}

describe('parseGcode extrusion classification', () => {
  it('renders absolute-E moves only when E increases', () => {
    expect(parsedSegments('M82\nG1 X10 Y0 E1\nG1 X20 Y0 E1\nG1 X30 Y0 E0.5')).toEqual({ extrusion: 1, travel: 2 })
  })

  it('handles relative extrusion mode', () => {
    expect(parsedSegments('M83\nG1 X10 Y0 E1\nG1 X20 Y0 E0\nG1 X30 Y0 E-1')).toEqual({ extrusion: 1, travel: 2 })
  })

  it('retains the accumulated E position when switching back to absolute mode', () => {
    expect(parsedSegments('M83\nG1 X10 Y0 E0.5\nG1 X20 Y0 E0.5\nM82\nG1 X30 Y0 E1')).toEqual({ extrusion: 2, travel: 1 })
  })

  it('applies G92 E resets before calculating the next extrusion delta', () => {
    expect(parsedSegments('M82\nG92 E10\nG1 X10 Y0 E11\nG92 E0\nG1 X20 Y0 E1')).toEqual({ extrusion: 2, travel: 0 })
  })

  it('applies G92 XYZ resets before the next absolute move', () => {
    const layer = parseGcode('M82\nG1 X10 Y5 E1\nG92 X0 Y0 E0\nG1 X5 Y0 E1').layers[0]
    expect(Array.from(layer.features[0].segments)).toEqual([
      -5, -2.5, 0, 5, 2.5, 0,
      -5, -2.5, 0, 0, -2.5, 0,
    ])
  })

  it('does not treat an E word on a G0 move as deposited material', () => {
    expect(parsedSegments('M82\nG0 X10 Y0 E1')).toEqual({ extrusion: 0, travel: 1 })
  })
})
