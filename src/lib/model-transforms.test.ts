import { describe, expect, it } from 'vitest'
import {
  encodeTransformTable,
  identityObjectTransform,
  parseObjectTransforms,
  sameObjectTransform,
} from './model-transforms'

describe('model transforms', () => {
  it('encodes the 11-float table and uses NaN for arrange-owned offsets', () => {
    const table = encodeTransformTable([identityObjectTransform()])
    expect(table).toBeDefined()
    expect(Array.from(table?.slice(0, 9) ?? [])).toEqual([1, 1, 1, 0, 0, 0, 1, 1, 1])
    expect(Number.isNaN(table?.[9])).toBe(true)
    expect(Number.isNaN(table?.[10])).toBe(true)
  })

  it('omits the table when every item uses legacy placement', () => {
    expect(encodeTransformTable([undefined, undefined])).toBeUndefined()
  })

  it('round-trips and validates bridge JSON', () => {
    const value = identityObjectTransform()
    value.offset = [2.5, -4]
    const parsed = parseObjectTransforms([value])
    expect(parsed).toEqual([value])
    expect(sameObjectTransform(parsed[0], value)).toBe(true)
    expect(() => parseObjectTransforms([{ ...value, mirror: [0, 1, 1] }])).toThrow(/mirror/)
  })
})
