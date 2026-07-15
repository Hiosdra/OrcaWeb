import { describe, expect, it } from 'vitest'
import type { OrcaModule } from '../types'
import { cadToStl, objToStl, read3mf, sliceMultiStl, sliceStl, write3mf } from './wasm-loader'

function fakeModule(failAt: number) {
  let allocation = 0
  const freed: number[] = []
  const module = {
    HEAPU8: {
      set: (_bytes: Uint8Array, ptr: number) => expect(ptr).not.toBe(0),
      slice: () => new Uint8Array(),
    },
    _malloc: () => (++allocation === failAt ? 0 : allocation * 16),
    _free: (ptr: number) => { expect(ptr).not.toBe(0); freed.push(ptr) },
    _orc_free: () => {}, getValue: () => 0,
    setValue: (ptr: number) => expect(ptr).not.toBe(0), UTF8ToString: () => '',
    _orc_decode_exception: () => 0,
    _orc_init: () => 0, _orc_slice: () => 0, _orc_slice_multi: () => 0,
    _orc_obj_to_stl: () => 0, _orc_cad_to_stl: () => 0, _orc_write_3mf: () => 0, _orc_read_3mf: () => 0,
  } as unknown as OrcaModule
  return { module, freed }
}

const data = new Uint8Array([1])
const scenarios: [string, number, (module: OrcaModule) => unknown][] = [
  ['sliceStl', 4, (m) => sliceStl(m, 1, data, '{}')],
  ['objToStl', 3, (m) => objToStl(m, data)],
  ['sliceMultiStl', 5, (m) => sliceMultiStl(m, 1, data, new Int32Array([0, 1]), 1, '{}')],
  ['sliceMultiStl extruders', 6, (m) => sliceMultiStl(m, 1, data, new Int32Array([0, 1]), 1, '{}', new Int32Array([1]))],
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
})
