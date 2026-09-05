import { describe, expect, it } from 'vitest'
import type { OrcaModule } from '../types'
import { encodeTransformTable } from './model-transforms'
import {
  cadToStl,
  humanizeSliceError,
  objToStl,
  preparePlate,
  read3mf,
  sliceMultiStl,
  sliceStl,
  write3mf,
} from './wasm-loader'

function fakeModule(failAt: number) {
  let allocation = 0
  const freed: number[] = []
  const module = {
    HEAPU8: {
      set: (bytes: Uint8Array, ptr: number) => {
        if (bytes.length > 0) expect(ptr).not.toBe(0)
      },
      slice: () => new Uint8Array(),
    },
    _malloc: () => (++allocation === failAt ? 0 : allocation * 16),
    _free: (ptr: number) => {
      expect(ptr).not.toBe(0)
      freed.push(ptr)
    },
    _orc_free: () => {},
    getValue: () => 0,
    setValue: (ptr: number) => expect(ptr).not.toBe(0),
    UTF8ToString: () => '',
    _orc_decode_exception: () => 0,
    _orc_init: () => 0,
    _orc_slice: () => 0,
    _orc_slice_multi: () => 0,
    _orc_prepare_plate: () => 0,
    _orc_obj_to_stl: () => 0,
    _orc_cad_to_stl: () => 0,
    _orc_write_3mf: () => 0,
    _orc_read_3mf: () => 0,
  } as unknown as OrcaModule
  return { module, freed }
}

const data = new Uint8Array([1])
const scenarios: [string, number, (module: OrcaModule) => unknown][] = [
  ['sliceStl', 4, (m) => sliceStl(m, 1, data, '{}')],
  ['objToStl', 3, (m) => objToStl(m, data)],
  ['sliceMultiStl', 5, (m) => sliceMultiStl(m, 1, data, new Int32Array([0, 1]), 1, '{}')],
  [
    'sliceMultiStl extruders',
    6,
    (m) => sliceMultiStl(m, 1, data, new Int32Array([0, 1]), 1, '{}', new Int32Array([1])),
  ],
  ['preparePlate', 5, (m) => preparePlate(m, 1, data, new Int32Array([0, 1]), 1, '{}', 'arrange')],
  ['write3mf', 4, (m) => write3mf(m, 1, data, '{}')],
  ['read3mf', 5, (m) => read3mf(m, data)],
  ['cadToStl', 3, (m) => cadToStl(m, data)],
]

describe('WASM allocation failures', () => {
  for (const [name, allocations, invoke] of scenarios) {
    it(`${name} rejects each failed allocation without leaking earlier pointers`, () => {
      for (let failAt = 1; failAt <= allocations; failAt++) {
        const { module, freed } = fakeModule(failAt)
        expect(() => invoke(module)).toThrow(/Out of memory allocating/)
        expect(freed).toHaveLength(failAt - 1)
      }
    })
  }

  it('permits zero-sized allocations without freeing null pointers', () => {
    const { module, freed } = fakeModule(Number.POSITIVE_INFINITY)
    module._malloc = (size: number) => (size === 0 ? 0 : 16)
    module.getValue = () => 32
    expect(() => sliceMultiStl(module, 1, new Uint8Array(), new Int32Array(), 0, '{}')).not.toThrow()
    expect(freed).toEqual([16, 16, 16])
  })
})

describe('WASM transform ABI', () => {
  it('keeps the transform pointer after the legacy slice output pointers', () => {
    const { module } = fakeModule(Number.POSITIVE_INFINITY)
    const calls: unknown[][] = []
    module._orc_slice = ((...args: unknown[]) => {
      calls.push(args)
      return 0
    }) as unknown as OrcaModule['_orc_slice']
    const transform = {
      scale: [2, 1, 0.5] as [number, number, number],
      rotation: [0.1, 0.2, 0.3] as [number, number, number],
      mirror: [1, -1, 1] as [number, number, number],
      offset: [4, -3] as [number, number],
    }
    const table = encodeTransformTable([transform])
    expect(table).toBeDefined()
    expect(() => sliceStl(module, 1, data, '{}', table)).not.toThrow()
    expect(calls[0]?.slice(3, 5)).toEqual([48, 64])
    expect(calls[0]?.[5]).toBe(80)
  })

  it('marshals the current-plate operation and transform table', () => {
    const { module } = fakeModule(Number.POSITIVE_INFINITY)
    const calls: unknown[][] = []
    module._orc_prepare_plate = ((...args: unknown[]) => {
      calls.push(args)
      return 0
    }) as unknown as OrcaModule['_orc_prepare_plate']
    const transforms = new Float32Array(11)
    expect(() => preparePlate(module, 1, data, new Int32Array([0, 1]), 1, '{}', 'arrange', transforms)).not.toThrow()
    expect(calls[0]?.[4]).toBe(1)
    expect(calls[0]?.[5]).toBe(64)
    expect(calls[0]?.[6]).toBe(2)
  })

  it('rejects a transform table that is not parallel to the input objects', () => {
    const { module } = fakeModule(Number.POSITIVE_INFINITY)
    expect(() =>
      sliceMultiStl(module, 1, data, new Int32Array([0, 1]), 1, '{}', undefined, new Float32Array(1)),
    ).toThrow(/expected 11/)
  })
})

describe('humanizeSliceError (#164)', () => {
  // The engine's own -6 message for the mixed-temperature guard.
  const engineMsg =
    "Selected nozzle temperatures are incompatible. Each filament's nozzle temperature must fall " +
    'within the recommended nozzle temperature range of the other filaments. Otherwise, nozzle ' +
    'clogging or printer damage may occur. If you still want to print, you can enable the option in ' +
    'Preferences / Control / Slicing / Remove mixed temperature restriction.'

  it('rewrites the desktop Preferences path into the in-app toggle', () => {
    const out = humanizeSliceError(engineMsg)
    expect(out).not.toMatch(/Preferences/)
    // Assert the *rendered sentence*, not just substring containment — the
    // lead-in "the option in" has to be consumed too, or the clauses collide
    // ("enable the option the … toggle"). This is the exact text a user sees.
    expect(out).toContain('you can enable the “Allow mixed-temperature filaments” toggle in the Filament settings.')
    expect(out).not.toContain('the option')
    // The diagnosis itself (why it failed) is preserved.
    expect(out).toContain('nozzle temperatures are incompatible')
  })

  it('tolerates whitespace/casing drift in the desktop menu path', () => {
    const drifted = engineMsg.replace(
      'Preferences / Control / Slicing / Remove mixed temperature restriction',
      'preferences/control/slicing/Remove mixed temperature restriction',
    )
    expect(humanizeSliceError(drifted)).toContain('Allow mixed-temperature filaments')
  })

  it('leaves unrelated messages untouched', () => {
    expect(humanizeSliceError('STL load failed')).toBe('STL load failed')
  })
})
