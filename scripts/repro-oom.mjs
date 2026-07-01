#!/usr/bin/env node
/**
 * Local repro harness for the "OOM on larger models" report.
 * Loads slicer.js/.wasm directly in Node (ENVIRONMENT=web,worker,node
 * covers this) and drives orc_init/orc_slice while logging WASM heap
 * size between calls, to see whether memory grows and never comes back
 * down (leak) vs. plateaus after the first call (expected growth).
 *
 * Usage: node scripts/repro-oom.mjs [gridSize] [iterations]
 */
import { createRequire } from 'module'
import { readFileSync, copyFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ── binary STL generator: an N x N x N grid of unit cubes (12 triangles each) ──
// This is a crude stand-in for "a bigger model than a calibration cube" —
// scales triangle count as N^3 * 12 so we can dial up complexity.
function makeCubeGridSTL(n) {
  const triPerCube = 12
  const triCount = n * n * n * triPerCube
  const headerSize = 80
  const buf = Buffer.alloc(headerSize + 4 + triCount * 50)
  buf.write('OrcaWeb repro STL', 0)
  buf.writeUInt32LE(triCount, headerSize)

  let off = headerSize + 4
  const faceNormals = [
    [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
  ]
  // 12 triangles (2 per face * 6 faces) for a unit cube at (x,y,z)
  function cubeTris(x, y, z) {
    const v = [
      [x, y, z], [x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z],
      [x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1],
    ]
    const faces = [
      [0, 1, 5, 4], [3, 2, 6, 7], [0, 4, 7, 3], [1, 5, 6, 2], [0, 3, 2, 1], [4, 7, 6, 5],
    ]
    const tris = []
    faces.forEach((f, fi) => {
      tris.push([v[f[0]], v[f[1]], v[f[2]], faceNormals[fi]])
      tris.push([v[f[0]], v[f[2]], v[f[3]], faceNormals[fi]])
    })
    return tris
  }

  for (let xi = 0; xi < n; xi++) {
    for (let yi = 0; yi < n; yi++) {
      for (let zi = 0; zi < n; zi++) {
        const tris = cubeTris(xi * 1.05, yi * 1.05, zi * 1.05)
        for (const [a, b, c, norm] of tris) {
          buf.writeFloatLE(norm[0], off); buf.writeFloatLE(norm[1], off + 4); buf.writeFloatLE(norm[2], off + 8)
          buf.writeFloatLE(a[0], off + 12); buf.writeFloatLE(a[1], off + 16); buf.writeFloatLE(a[2], off + 20)
          buf.writeFloatLE(b[0], off + 24); buf.writeFloatLE(b[1], off + 28); buf.writeFloatLE(b[2], off + 32)
          buf.writeFloatLE(c[0], off + 36); buf.writeFloatLE(c[1], off + 40); buf.writeFloatLE(c[2], off + 44)
          off += 50 // 12 floats (48B) + 2B attribute byte count
        }
      }
    }
  }
  return buf
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main() {
  const gridSize = Number(process.argv[2] ?? 6)   // 6^3 = 216 cubes = 2592 triangles (small, warmup)
  const iterations = Number(process.argv[3] ?? 3)

  console.log(`\nBuilding ${gridSize}x${gridSize}x${gridSize} cube-grid STL...`)
  const stl = makeCubeGridSTL(gridSize)
  console.log(`STL size: ${fmtMB(stl.length)} (${((stl.length - 84) / 50).toLocaleString()} triangles)\n`)

  const wasmDir = join(__dirname, '../public/wasm')
  // package.json has "type": "module", so plain .js is parsed as ESM and
  // module.exports=... inside slicer.js becomes a no-op. Force CJS via .cjs.
  const cjsPath = join(wasmDir, 'slicer.cjs')
  copyFileSync(join(wasmDir, 'slicer.js'), cjsPath)
  const factory = require(cjsPath)
  const wasmBinary = readFileSync(join(wasmDir, 'slicer.wasm'))

  console.log('Instantiating WASM module...')
  const Module = await factory({
    wasmBinary,
    locateFile: (p) => join(wasmDir, p),
    printErr: (m) => console.warn('[stderr]', m),
    onAbort: (m) => console.error('[ABORT]', m),
  })
  console.log(`Initial heap: ${fmtMB(Module.HEAP8.buffer.byteLength)}\n`)

  const encoder = new TextEncoder()
  // Built-in defaults use relative-E addressing, which validate() rejects
  // unless layer_gcode resets E each layer. Disable it to keep the config minimal.
  const configBytes = encoder.encode(JSON.stringify({ use_relative_e_distances: '0' }))

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

    const result = Module._orc_slice(stlPtr, stl.length, outPtrPtr, outLenPtr)
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
