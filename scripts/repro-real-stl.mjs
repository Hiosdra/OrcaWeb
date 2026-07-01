#!/usr/bin/env node
/**
 * Repro harness using a REAL STL file (e.g. the official Voron Design
 * Cube v7) instead of a synthetic mesh, to test whether print SETTINGS
 * (fine layers, high infill, many perimeters) rather than raw triangle
 * count are what drive the reported OOM.
 *
 * Usage: node scripts/repro-real-stl.mjs <path.stl> [presetName] [iterations]
 * Presets: default | fine | extreme
 */
import { createRequire } from 'module'
import { readFileSync, copyFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const PRESETS = {
  default: { use_relative_e_distances: '0' },
  fine: {
    use_relative_e_distances: '0',
    layer_height: '0.08',
    fill_density: '100%',
    perimeters: '6',
  },
  extreme: {
    use_relative_e_distances: '0',
    layer_height: '0.04',
    fill_density: '100%',
    perimeters: '10',
    top_shell_layers: '20',
    bottom_shell_layers: '20',
  },
  noarc: { use_relative_e_distances: '0', enable_arc_fitting: '0' },
  classic: { use_relative_e_distances: '0', perimeter_generator: 'classic' },
  nosupport: { use_relative_e_distances: '0', enable_support: '0', support_material: '0' },
  simplefill: { use_relative_e_distances: '0', fill_pattern: 'grid', top_surface_pattern: 'rectilinear', bottom_surface_pattern: 'rectilinear' },
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main() {
  const stlPath = process.argv[2]
  const presetName = process.argv[3] ?? 'default'
  const iterations = Number(process.argv[4] ?? 1)
  if (!stlPath) {
    console.error('Usage: node scripts/repro-real-stl.mjs <path.stl> [preset] [iterations]')
    process.exit(1)
  }
  const preset = PRESETS[presetName]
  if (!preset) {
    console.error(`Unknown preset "${presetName}". Options: ${Object.keys(PRESETS).join(', ')}`)
    process.exit(1)
  }

  const stl = readFileSync(stlPath)
  console.log(`\nSTL: ${stlPath}`)
  console.log(`Size: ${fmtMB(stl.length)}  Triangles: ${((stl.length - 84) / 50).toLocaleString()}`)
  console.log(`Preset: ${presetName} -> ${JSON.stringify(preset)}\n`)

  const wasmDir = join(__dirname, '../public/wasm')
  const cjsPath = join(wasmDir, 'slicer.cjs')
  copyFileSync(join(wasmDir, 'slicer.js'), cjsPath)
  const factory = require(cjsPath)
  const wasmBinary = readFileSync(join(wasmDir, 'slicer.wasm'))

  const Module = await factory({
    wasmBinary,
    locateFile: (p) => join(wasmDir, p),
    printErr: (m) => console.warn('[stderr]', m),
    onAbort: (m) => console.error('[ABORT]', m),
  })
  console.log(`Initial heap: ${fmtMB(Module.HEAP8.buffer.byteLength)}\n`)

  const encoder = new TextEncoder()
  const configBytes = encoder.encode(JSON.stringify(preset))

  for (let i = 1; i <= iterations; i++) {
    const t0 = Date.now()
    const heapBefore = Module.HEAP8.buffer.byteLength

    const configPtr = Module._malloc(configBytes.length)
    Module.HEAPU8.set(configBytes, configPtr)
    const initResult = Module._orc_init(configPtr, configBytes.length)
    Module._free(configPtr)
    if (initResult !== 0) {
      const errPtr = Module._orc_decode_exception(0)
      console.error(`orc_init failed (${initResult}): ${Module.UTF8ToString(errPtr)}`)
      process.exit(1)
    }

    const stlPtr = Module._malloc(stl.length)
    Module.HEAPU8.set(stl, stlPtr)
    const outPtrPtr = Module._malloc(4)
    const outLenPtr = Module._malloc(4)

    let result
    try {
      result = Module._orc_slice(stlPtr, stl.length, outPtrPtr, outLenPtr)
    } catch (err) {
      console.error(`\n[iter ${i}] NATIVE THROW / possible abort:`, err)
      console.log(`  heap before=${fmtMB(heapBefore)} rss=${fmtMB(process.memoryUsage().rss)}`)
      process.exit(2)
    }
    Module._free(stlPtr)

    const heapAfterSlice = Module.HEAP8.buffer.byteLength

    if (result !== 0) {
      const errPtr = Module._orc_decode_exception(0)
      console.error(`\n[iter ${i}] orc_slice FAILED (code ${result}): ${Module.UTF8ToString(errPtr)}`)
      Module._free(outPtrPtr)
      Module._free(outLenPtr)
      console.log(`  heap before=${fmtMB(heapBefore)} after=${fmtMB(heapAfterSlice)}`)
      process.exit(result)
    }

    const gcodePtr = Module.getValue(outPtrPtr, 'i32')
    const gcodeLen = Module.getValue(outLenPtr, 'i32')
    Module._orc_free(gcodePtr)
    Module._free(outPtrPtr)
    Module._free(outLenPtr)

    const heapAfterFree = Module.HEAP8.buffer.byteLength
    const dt = Date.now() - t0

    console.log(
      `[iter ${i}] gcode=${fmtMB(gcodeLen)} time=${dt}ms  ` +
      `heap: before=${fmtMB(heapBefore)} afterSlice=${fmtMB(heapAfterSlice)} afterFree=${fmtMB(heapAfterFree)}  ` +
      `rss=${fmtMB(process.memoryUsage().rss)}`
    )
  }
}

main().catch((err) => {
  console.error('\nFatal:', err)
  process.exit(1)
})
