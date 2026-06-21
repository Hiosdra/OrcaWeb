import type { OrcaModule, OrcaModuleFactory } from '../types'

const WASM_BASE = '/wasm'

let modulePromise: Promise<OrcaModule> | null = null

export async function loadOrcaModule(): Promise<OrcaModule> {
  if (modulePromise) return modulePromise

  modulePromise = (async () => {
    const [wasmBinary, jsText] = await Promise.all([
      fetch(`${WASM_BASE}/slicer.wasm`).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch slicer.wasm: ${r.status}`)
        return r.arrayBuffer()
      }),
      fetch(`${WASM_BASE}/slicer.js`).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch slicer.js: ${r.status}`)
        return r.text()
      }),
    ])

    // Wrap CommonJS module as ES default export for dynamic import
    const blob = new Blob(
      [`${jsText}\nexport default OrcaModule;`],
      { type: 'application/javascript' },
    )
    const url = URL.createObjectURL(blob)

    let factory: OrcaModuleFactory
    try {
      const mod = await import(/* @vite-ignore */ url)
      factory = mod.default as OrcaModuleFactory
    } finally {
      URL.revokeObjectURL(url)
    }

    const module = await factory({
      wasmBinary,
      locateFile: (path: string) => `${WASM_BASE}/${path}`,
      printErr: (msg: string) => console.warn('[OrcaWASM]', msg),
    })

    return module
  })()

  return modulePromise
}

export function sliceStl(
  module: OrcaModule,
  stlData: Uint8Array,
  configJson: string,
): string {
  const encoder = new TextEncoder()
  const configBytes = encoder.encode(configJson)

  // Write config to WASM heap
  const configPtr = module._malloc(configBytes.length)
  module.HEAPU8.set(configBytes, configPtr)

  const initResult = module._orc_init(configPtr, configBytes.length)
  module._free(configPtr)

  if (initResult !== 0) {
    throw new OrcaSliceError(initResult, wasmError(module, initResult))
  }

  // Write STL data to WASM heap
  const stlPtr = module._malloc(stlData.length)
  module.HEAPU8.set(stlData, stlPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  const sliceResult = module._orc_slice(stlPtr, stlData.length, outPtrPtr, outLenPtr)

  module._free(stlPtr)

  if (sliceResult !== 0) {
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new OrcaSliceError(sliceResult, wasmError(module, sliceResult))
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
      throw new OrcaSliceError(result, wasmError(module, result))
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
  data: Uint8Array,
  offsets: Int32Array,
  nFiles: number,
  configJson: string,
): string {
  const encoder = new TextEncoder()
  const configBytes = encoder.encode(configJson)

  const configPtr = module._malloc(configBytes.length)
  module.HEAPU8.set(configBytes, configPtr)
  const initResult = module._orc_init(configPtr, configBytes.length)
  module._free(configPtr)
  if (initResult !== 0) throw new OrcaSliceError(initResult, wasmError(module, initResult))

  const dataPtr = module._malloc(data.length)
  module.HEAPU8.set(data, dataPtr)

  // Write int32 offset pairs to WASM heap using setValue so endianness is always correct
  const offsetsPtr = module._malloc(offsets.length * 4)
  for (let i = 0; i < offsets.length; i++) {
    module.setValue(offsetsPtr + i * 4, offsets[i], 'i32')
  }

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  const result = module._orc_slice_multi(dataPtr, data.length, offsetsPtr, nFiles, outPtrPtr, outLenPtr)
  module._free(dataPtr)
  module._free(offsetsPtr)

  if (result !== 0) {
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new OrcaSliceError(result, wasmError(module, result))
  }

  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)

  module._orc_free(gcodePtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)

  return gcode
}

export function cadToStl(module: OrcaModule, cadData: Uint8Array, filename: string): Uint8Array {
  const isIges = /\.(iges|igs)$/i.test(filename) ? 1 : 0

  const cadPtr = module._malloc(cadData.length)
  module.HEAPU8.set(cadData, cadPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  try {
    const result = module._orc_cad_to_stl(cadData.length === 0 ? 0 : cadPtr, cadData.length, isIges, outPtrPtr, outLenPtr)
    if (result !== 0) {
      throw new OrcaSliceError(result, cadErrorMessage(result))
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
function wasmError(module: OrcaModule, code: number): string {
  try {
    const ptr = module._orc_decode_exception(0)
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

function cadErrorMessage(code: number): string {
  switch (code) {
    case -1: return 'CAD conversion called with invalid arguments (internal error)'
    case -3: return 'Could not stage CAD file for conversion'
    case -4: return 'CAD load failed (invalid or unsupported STEP/IGES file)'
    case -5: return 'CAD file contains no geometry'
    case -8: return 'STL export failed after CAD tessellation'
    case -9: return 'Unexpected exception during CAD conversion'
    default: return `CAD conversion error (code ${code})`
  }
}
