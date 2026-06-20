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
    throw new OrcaSliceError(initResult, `orc_init failed with code ${initResult}`)
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
    throw new OrcaSliceError(sliceResult, sliceErrorMessage(sliceResult))
  }

  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)

  module._free(gcodePtr)
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
      throw new OrcaSliceError(result, objErrorMessage(result))
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

export class OrcaSliceError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'OrcaSliceError'
  }
}

function sliceErrorMessage(code: number): string {
  switch (code) {
    case -1: return 'Failed to load STL file (invalid or corrupt geometry)'
    case -2: return 'No printable objects found on the plate'
    case -3: return 'G-code generation failed'
    case -4: return 'Internal OrcaSlicer exception'
    default: return `Unknown slice error (code ${code})`
  }
}

function objErrorMessage(code: number): string {
  switch (code) {
    case -1: return 'OBJ conversion called with invalid arguments (internal error)'
    case -3: return 'Could not stage OBJ file for conversion'
    case -4: return 'OBJ load failed (invalid or unsupported format)'
    case -5: return 'OBJ file contains no geometry'
    case -8: return 'STL export failed after OBJ conversion'
    default: return `OBJ conversion error (code ${code})`
  }
}
