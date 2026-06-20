import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { WASM_DIR } from './download.ts'

export interface SliceOptions {
  stlPath: string
  outputPath: string
  config: Record<string, unknown>
}

export interface OrcaModule {
  _malloc(size: number): number
  _free(ptr: number): void
  _orc_init(ptr: number, len: number): number
  _orc_slice(inPtr: number, inLen: number, outPtrPtr: number, outLenPtr: number): number
  setValue(ptr: number, value: number, type: string): void
  getValue(ptr: number, type: string): number
  UTF8ToString(ptr: number, len?: number): string
  HEAPU8: Uint8Array
}

const SLICE_ERRORS: Record<number, string> = {
  [-1]: 'Failed to load STL (invalid or corrupt geometry)',
  [-2]: 'No printable objects on the plate',
  [-3]: 'G-code generation failed',
  [-4]: 'Internal OrcaSlicer exception',
}

export async function loadModule(): Promise<OrcaModule> {
  const jsPath = join(WASM_DIR, 'slicer.js')
  const wasmPath = join(WASM_DIR, 'slicer.wasm')

  const wasmBinary = readFileSync(wasmPath).buffer as ArrayBuffer

  // Load CommonJS slicer.js via require
  const require = createRequire(import.meta.url)
  const factory = require(jsPath) as (opts: unknown) => Promise<OrcaModule>

  const module = await factory({
    wasmBinary,
    locateFile: (name: string) => join(WASM_DIR, name),
    printErr: (msg: string) => process.stderr.write(`[OrcaWASM] ${msg}\n`),
  })

  return module
}

export function sliceStl(module: OrcaModule, options: SliceOptions): string {
  const { stlPath, config } = options

  // Init with config
  const configJson = JSON.stringify(config)
  const configBytes = Buffer.from(configJson, 'utf8')
  const configPtr = module._malloc(configBytes.length)
  module.HEAPU8.set(configBytes, configPtr)
  const initResult = module._orc_init(configPtr, configBytes.length)
  module._free(configPtr)

  if (initResult !== 0) {
    throw new Error(`orc_init failed (${initResult}): ${SLICE_ERRORS[initResult] ?? 'unknown'}`)
  }

  // Load and slice STL
  const stlData = readFileSync(stlPath)
  const stlPtr = module._malloc(stlData.length)
  module.HEAPU8.set(stlData, stlPtr)

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)

  const sliceResult = module._orc_slice(stlPtr, stlData.length, outPtrPtr, outLenPtr)
  module._free(stlPtr)

  if (sliceResult !== 0) {
    module._free(outPtrPtr)
    module._free(outLenPtr)
    const msg = SLICE_ERRORS[sliceResult] ?? `Unknown error (${sliceResult})`
    throw new Error(`Slice failed: ${msg}`)
  }

  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)

  module._free(gcodePtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)

  return gcode
}

export function writeGcode(gcode: string, outputPath: string): void {
  writeFileSync(outputPath, gcode, 'utf8')
}
