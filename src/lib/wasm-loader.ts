// Loading/instantiating the WASM module lives in src/workers/slicer.worker.ts
// (the only caller) — this file holds the pure call helpers around the
// orc_* bridge exports plus their error decoding.
import type { OrcaModule } from '../types'
import { logWarn } from './log'

type Allocate = (size: number, label: string) => number

function checkedMalloc(module: OrcaModule, size: number, label: string): number {
  const ptr = module._malloc(size)
  if (ptr === 0 && size !== 0) throw new Error(`Out of memory allocating ${label} (${size} bytes)`)
  return ptr
}

function withAllocations<T>(module: OrcaModule, operation: (allocate: Allocate) => T): T {
  const pointers: number[] = []
  const allocate: Allocate = (size, label) => {
    const ptr = checkedMalloc(module, size, label)
    if (ptr !== 0) pointers.push(ptr)
    return ptr
  }
  try {
    return operation(allocate)
  } finally {
    for (const ptr of pointers.reverse()) module._free(ptr)
  }
}

function initSession(module: OrcaModule, session: number, configJson: string): void {
  const configBytes = new TextEncoder().encode(configJson)
  const result = withAllocations(module, (allocate) => {
    const configPtr = allocate(configBytes.length, 'config')
    module.HEAPU8.set(configBytes, configPtr)
    return module._orc_init(session, configPtr, configBytes.length)
  })
  if (result !== 0) throw new OrcaSliceError(result, wasmError(module, session, result))
}

export function sliceStl(module: OrcaModule, session: number, stlData: Uint8Array, configJson: string): string {
  initSession(module, session, configJson)
  return withAllocations(module, (allocate) => {
    const stlPtr = allocate(stlData.length, 'STL data')
    module.HEAPU8.set(stlData, stlPtr)
    const outPtrPtr = allocate(4, 'G-code output pointer')
    const outLenPtr = allocate(4, 'G-code output length')
    const result = module._orc_slice(session, stlPtr, stlData.length, outPtrPtr, outLenPtr)
    if (result !== 0) throw new OrcaSliceError(result, wasmError(module, session, result))
    const gcodePtr = module.getValue(outPtrPtr, 'i32')
    const gcodeLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.UTF8ToString(gcodePtr, gcodeLen)
    } finally {
      module._orc_free(gcodePtr)
    }
  })
}

function convertToStl(
  module: OrcaModule, data: Uint8Array, label: string,
  convert: (dataPtr: number, outPtrPtr: number, outLenPtr: number) => number,
): Uint8Array {
  return withAllocations(module, (allocate) => {
    const dataPtr = allocate(data.length, label)
    module.HEAPU8.set(data, dataPtr)
    const outPtrPtr = allocate(4, 'STL output pointer')
    const outLenPtr = allocate(4, 'STL output length')
    const result = convert(dataPtr, outPtrPtr, outLenPtr)
    if (result !== 0) throw new OrcaSliceError(result, wasmError(module, 0, result))
    const stlPtr = module.getValue(outPtrPtr, 'i32')
    const stlLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.HEAPU8.slice(stlPtr, stlPtr + stlLen)
    } finally {
      module._orc_free(stlPtr)
    }
  })
}

export function objToStl(module: OrcaModule, objData: Uint8Array): Uint8Array {
  return convertToStl(module, objData, 'OBJ data', (objPtr, outPtrPtr, outLenPtr) =>
    module._orc_obj_to_stl(objPtr, objData.length, outPtrPtr, outLenPtr))
}

export function sliceMultiStl(
  module: OrcaModule, session: number, data: Uint8Array, offsets: Int32Array, nFiles: number,
  configJson: string, extruderIds?: Int32Array,
): string {
  initSession(module, session, configJson)
  return withAllocations(module, (allocate) => {
    const dataPtr = allocate(data.length, 'combined STL data')
    module.HEAPU8.set(data, dataPtr)
    const offsetsPtr = allocate(offsets.length * 4, 'STL offset table')
    for (let i = 0; i < offsets.length; i++) module.setValue(offsetsPtr + i * 4, offsets[i], 'i32')

    const extruderIdsPtr = extruderIds?.length
      ? allocate(extruderIds.length * 4, 'extruder ID table')
      : 0
    if (extruderIds) {
      for (let i = 0; i < extruderIds.length; i++) module.setValue(extruderIdsPtr + i * 4, extruderIds[i], 'i32')
    }

    const outPtrPtr = allocate(4, 'G-code output pointer')
    const outLenPtr = allocate(4, 'G-code output length')
    const result = module._orc_slice_multi(
      session, dataPtr, data.length, offsetsPtr, nFiles, extruderIdsPtr, outPtrPtr, outLenPtr,
    )
    if (result !== 0) throw new OrcaSliceError(result, wasmError(module, session, result))
    const gcodePtr = module.getValue(outPtrPtr, 'i32')
    const gcodeLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.UTF8ToString(gcodePtr, gcodeLen)
    } finally {
      module._orc_free(gcodePtr)
    }
  })
}

export function write3mf(module: OrcaModule, session: number, stlData: Uint8Array, configJson: string): Uint8Array {
  initSession(module, session, configJson)
  return withAllocations(module, (allocate) => {
    const stlPtr = allocate(stlData.length, 'STL data')
    module.HEAPU8.set(stlData, stlPtr)
    const outPtrPtr = allocate(4, '3MF output pointer')
    const outLenPtr = allocate(4, '3MF output length')
    const result = module._orc_write_3mf(session, stlPtr, stlData.length, outPtrPtr, outLenPtr)
    if (result !== 0) throw new OrcaSliceError(result, wasmError(module, session, result))
    const dataPtr = module.getValue(outPtrPtr, 'i32')
    const dataLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.HEAPU8.slice(dataPtr, dataPtr + dataLen)
    } finally {
      module._orc_free(dataPtr)
    }
  })
}

export interface Read3mfResult { stl: Uint8Array; configJson: string }

export function read3mf(module: OrcaModule, mfData: Uint8Array): Read3mfResult {
  return withAllocations(module, (allocate) => {
    const mfPtr = allocate(mfData.length, '3MF data')
    module.HEAPU8.set(mfData, mfPtr)
    const outStlPtrPtr = allocate(4, 'STL output pointer')
    const outStlLenPtr = allocate(4, 'STL output length')
    const outConfigPtrPtr = allocate(4, 'config output pointer')
    const outConfigLenPtr = allocate(4, 'config output length')
    const result = module._orc_read_3mf(mfPtr, mfData.length, outStlPtrPtr, outStlLenPtr, outConfigPtrPtr, outConfigLenPtr)
    if (result !== 0) throw new OrcaSliceError(result, wasmError(module, 0, result))
    const stlPtr = module.getValue(outStlPtrPtr, 'i32')
    const stlLen = module.getValue(outStlLenPtr, 'i32')
    const configPtr = module.getValue(outConfigPtrPtr, 'i32')
    const configLen = module.getValue(outConfigLenPtr, 'i32')
    try {
      return { stl: module.HEAPU8.slice(stlPtr, stlPtr + stlLen), configJson: module.UTF8ToString(configPtr, configLen) }
    } finally {
      module._orc_free(stlPtr)
      module._orc_free(configPtr)
    }
  })
}

export function cadToStl(module: OrcaModule, cadData: Uint8Array): Uint8Array {
  if (cadData.length === 0) throw new Error('CAD data is empty')
  return convertToStl(module, cadData, 'CAD data', (cadPtr, outPtrPtr, outLenPtr) =>
    module._orc_cad_to_stl(cadPtr, cadData.length, outPtrPtr, outLenPtr))
}

export class OrcaSliceError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message)
    this.name = 'OrcaSliceError'
  }
}

function wasmError(module: OrcaModule, session: number, code: number): string {
  try {
    const ptr = module._orc_decode_exception(session)
    if (ptr) {
      const msg = module.UTF8ToString(ptr)
      if (msg) return msg
    }
  } catch (err) {
    logWarn('[OrcaWASM] _orc_decode_exception threw — falling back to code-based message', err)
  }
  switch (code) {
    case -1: return 'Invalid or uninitialized state'
    case -2: return 'Config JSON parse failure'
    case -3: return 'Failed to write STL to MEMFS'
    case -4: return 'STL load failed (invalid or corrupt geometry)'
    case -5: return 'Model contains no objects'
    case -6: return 'Print validation failed'
    case -7: return 'Slicing error'
    case -8: return 'G-code export failed'
    case -9: return 'Unexpected C++ exception'
    default: return `Unknown error (code ${code})`
  }
}
