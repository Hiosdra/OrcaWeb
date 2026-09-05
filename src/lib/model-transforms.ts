import type { ObjectTransform } from '../types'

/** Number of floats the bridge reserves for one object transform. */
export const TRANSFORM_STRIDE = 11

export function identityObjectTransform(): ObjectTransform {
  return {
    scale: [1, 1, 1],
    rotation: [0, 0, 0],
    mirror: [1, 1, 1],
    offset: null,
  }
}

/**
 * Encode the public transform shape into the engine ABI:
 * scale, rotation, mirror, and an optional X/Y offset relative to bed centre.
 * A missing table is intentional: it preserves the old bridge placement path.
 */
export function encodeTransformTable(transforms: (ObjectTransform | undefined)[]): Float32Array | undefined {
  if (!transforms.some((transform) => transform !== undefined)) return undefined

  const table = new Float32Array(transforms.length * TRANSFORM_STRIDE)
  transforms.forEach((transform, index) => {
    const value = transform ?? identityObjectTransform()
    const offset = index * TRANSFORM_STRIDE
    table.set(value.scale, offset)
    table.set(value.rotation, offset + 3)
    table.set(value.mirror, offset + 6)
    table[offset + 9] = value.offset?.[0] ?? Number.NaN
    table[offset + 10] = value.offset?.[1] ?? Number.NaN
  })
  return table
}

function isFiniteTuple(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  )
}

function parseTransform(value: unknown, index: number): ObjectTransform {
  if (!value || typeof value !== 'object') throw new Error(`Invalid transform at index ${index}`)
  const candidate = value as Record<string, unknown>
  if (!isFiniteTuple(candidate.scale, 3) || candidate.scale.some((entry) => entry <= 0)) {
    throw new Error(`Invalid scale in transform at index ${index}`)
  }
  if (!isFiniteTuple(candidate.rotation, 3)) throw new Error(`Invalid rotation in transform at index ${index}`)
  if (!isFiniteTuple(candidate.mirror, 3) || candidate.mirror.some((entry) => entry !== 1 && entry !== -1)) {
    throw new Error(`Invalid mirror in transform at index ${index}`)
  }
  const offset = candidate.offset
  if (offset !== null && !isFiniteTuple(offset, 2)) throw new Error(`Invalid offset in transform at index ${index}`)

  return {
    scale: [candidate.scale[0], candidate.scale[1], candidate.scale[2]],
    rotation: [candidate.rotation[0], candidate.rotation[1], candidate.rotation[2]],
    mirror: [candidate.mirror[0], candidate.mirror[1], candidate.mirror[2]],
    offset: offset === null ? null : [offset[0], offset[1]],
  }
}

/** Parse and validate the JSON returned by the bridge's prepare operation. */
export function parseObjectTransforms(value: unknown): ObjectTransform[] {
  if (!Array.isArray(value)) throw new Error('Plate action returned an invalid transform list')
  return value.map(parseTransform)
}

export function sameObjectTransform(a: ObjectTransform | undefined, b: ObjectTransform | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.scale.every((value, index) => value === b.scale[index]) &&
    a.rotation.every((value, index) => value === b.rotation[index]) &&
    a.mirror.every((value, index) => value === b.mirror[index]) &&
    (a.offset === null
      ? b.offset === null
      : b.offset !== null && a.offset.every((value, index) => value === b.offset?.[index]))
  )
}
