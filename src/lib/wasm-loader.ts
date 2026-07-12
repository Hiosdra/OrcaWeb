// Loading/instantiating the WASM module lives in src/workers/slicer.worker.ts
// (the only caller) — this file holds the pure call helpers around the
// orc_* bridge exports plus their error decoding.
import type { OrcaModule } from '../types'

export function sliceStl(
  module: OrcaModule,
  session: number,
  stlData: Uint8Array,
  configJson: string,
): string {
  const encoder = new TextEncoder()
  const configBytes = encoder.encode(configJson)

  // Write config to WASM heap
  const configPtr = module._malloc(configBytes.length)
  module.HEAPU8.set(configBytes, configPtr)

  const initResult = module._orc_init(session, configPtr, configBytes.length)
  module._free(configPtr)

  if (initResult !== 0) {
    throw new OrcaSliceError(initResult, wasmError(module, session, initResult))
  }

  // Write STL data to WASM heap
  const stlPtr = module._malloc(stlData.length)
  module.HEAPU8.set(stlData, stlPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  const sliceResult = module._orc_slice(session, stlPtr, stlData.length, outPtrPtr, outLenPtr)

  module._free(stlPtr)

  if (sliceResult !== 0) {
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new OrcaSliceError(sliceResult, wasmError(module, session, sliceResult))
  }

  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)

  module._orc_free(gcodePtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)

  return gcode
}

export function objToStl(module: OrcaModule, objData: Uint8Array): Uint8Array {
  const objPtr = module._malloc(objData.length)
  module.HEAPU8.set(objData, objPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  try {
    const result = module._orc_obj_to_stl(objPtr, objData.length, outPtrPtr, outLenPtr)
    if (result !== 0) {
      // No session — orc_obj_to_stl never touches slicer config state.
      throw new OrcaSliceError(result, wasmError(module, 0, result))
    }

    const stlPtr = module.getValue(outPtrPtr, 'i32')
    const stlLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.HEAPU8.slice(stlPtr, stlPtr + stlLen)
    } finally {
      module._orc_free(stlPtr)
    }
  } finally {
    module._free(objPtr)
    module._free(outPtrPtr)
    module._free(outLenPtr)
  }
}

export function sliceMultiStl(
  module: OrcaModule,
  session: number,
  data: Uint8Array,
  offsets: Int32Array,
  nFiles: number,
  configJson: string,
  // Optional per-object "extruder" override, one 1-based index per file
  // (0 = inherit default). See orc_slice_multi in orca-wasm/bridge/slicer.cpp
  // for exactly what this does (single-nozzle multi-material filament
  // assignment) and does not do (it does not enable multi-nozzle machines).
  extruderIds?: Int32Array,
): string {
  const encoder = new TextEncoder()
  const configBytes = encoder.encode(configJson)

  const configPtr = module._malloc(configBytes.length)
  module.HEAPU8.set(configBytes, configPtr)
  const initResult = module._orc_init(session, configPtr, configBytes.length)
  module._free(configPtr)
  if (initResult !== 0) throw new OrcaSliceError(initResult, wasmError(module, session, initResult))

  const dataPtr = module._malloc(data.length)
  module.HEAPU8.set(data, dataPtr)

  // Write int32 offset pairs to WASM heap using setValue so endianness is always correct
  const offsetsPtr = module._malloc(offsets.length * 4)
  for (let i = 0; i < offsets.length; i++) {
    module.setValue(offsetsPtr + i * 4, offsets[i], 'i32')
  }

  let extruderIdsPtr = 0
  if (extruderIds && extruderIds.length > 0) {
    extruderIdsPtr = module._malloc(extruderIds.length * 4)
    for (let i = 0; i < extruderIds.length; i++) {
      module.setValue(extruderIdsPtr + i * 4, extruderIds[i], 'i32')
    }
  }

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  const result = module._orc_slice_multi(
    session, dataPtr, data.length, offsetsPtr, nFiles, extruderIdsPtr, outPtrPtr, outLenPtr,
  )
  module._free(dataPtr)
  module._free(offsetsPtr)
  if (extruderIdsPtr) module._free(extruderIdsPtr)

  if (result !== 0) {
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new OrcaSliceError(result, wasmError(module, session, result))
  }

  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)

  module._orc_free(gcodePtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)

  return gcode
}

export function write3mf(
  module: OrcaModule,
  session: number,
  stlData: Uint8Array,
  configJson: string,
): Uint8Array {
  const encoder = new TextEncoder()
  const configBytes = encoder.encode(configJson)

  const configPtr = module._malloc(configBytes.length)
  module.HEAPU8.set(configBytes, configPtr)
  const initResult = module._orc_init(session, configPtr, configBytes.length)
  module._free(configPtr)
  if (initResult !== 0) throw new OrcaSliceError(initResult, wasmError(module, session, initResult))

  const stlPtr = module._malloc(stlData.length)
  module.HEAPU8.set(stlData, stlPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  try {
    const result = module._orc_write_3mf(session, stlPtr, stlData.length, outPtrPtr, outLenPtr)
    if (result !== 0) {
      throw new OrcaSliceError(result, wasmError(module, session, result))
    }

    const dataPtr = module.getValue(outPtrPtr, 'i32')
    const dataLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.HEAPU8.slice(dataPtr, dataPtr + dataLen)
    } finally {
      module._orc_free(dataPtr)
    }
  } finally {
    module._free(stlPtr)
    module._free(outPtrPtr)
    module._free(outLenPtr)
  }
}

export function cadToStl(module: OrcaModule, cadData: Uint8Array): Uint8Array {
  if (cadData.length === 0) {
    throw new Error('CAD data is empty')
  }

  const cadPtr = module._malloc(cadData.length)
  module.HEAPU8.set(cadData, cadPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  try {
    const result = module._orc_cad_to_stl(cadPtr, cadData.length, outPtrPtr, outLenPtr)
    if (result !== 0) {
      // No session — orc_cad_to_stl never touches slicer config state.
      throw new OrcaSliceError(result, wasmError(module, 0, result))
    }

    const stlPtr = module.getValue(outPtrPtr, 'i32')
    const stlLen = module.getValue(outLenPtr, 'i32')
    try {
      return module.HEAPU8.slice(stlPtr, stlPtr + stlLen)
    } finally {
      module._orc_free(stlPtr)
    }
  } finally {
    module._free(cadPtr)
    module._free(outPtrPtr)
    module._free(outLenPtr)
  }
}

export class OrcaSliceError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'OrcaSliceError'
  }
}

// Read the last error string stored by the C++ bridge via orc_decode_exception.
// Falls back to a code-based description when the C string is empty.
// Pass the session used for the failing call, or 0 for orc_obj_to_stl/orc_cad_to_stl.
function wasmError(module: OrcaModule, session: number, code: number): string {
  try {
    const ptr = module._orc_decode_exception(session)
    if (ptr) {
      const msg = module.UTF8ToString(ptr)
      if (msg) return msg
    }
  } catch { /* fall through to code-based fallback */ }
  // Matches the error codes documented in orca-wasm/bridge/slicer.cpp
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
