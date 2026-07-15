// Shared Node test harness for the OrcaSlicer WASM engine — used by
// smoke-test.mjs and compare-st-mt.mjs. Centralizes the ABI-coupled pieces
// (module loading + heap marshaling for orc_init/orc_slice/orc_slice_multi)
// so the C bridge's calling convention lives in ONE place instead of being
// copy-pasted and drifting between scripts.
//
// Plain Node ESM (no TS build step); the browser app uses src/lib/wasm-loader.ts
// for the same job. The two are intentionally separate — this one has no TS
// toolchain and runs standalone from the repo.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

// ── synthetic meshes ─────────────────────────────────────────────────────────

export function icosphere(subdivisions) {
  const t = (1 + Math.sqrt(5)) / 2
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]

  const midpointCache = new Map()
  const midpoint = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`
    if (midpointCache.has(key)) return midpointCache.get(key)
    const [ax, ay, az] = verts[a], [bx, by, bz] = verts[b]
    verts.push([(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2])
    const idx = verts.length - 1
    midpointCache.set(key, idx)
    return idx
  }

  for (let s = 0; s < subdivisions; s++) {
    const nextFaces = []
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a)
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = nextFaces
  }

  // Normalize to unit sphere, scale to a 10mm-radius solid, lift so min z = 0
  // (matches how the real bridge expects/centers a model — see orc_slice's
  // center_object_xy_only() call, which handles X/Y but leaves Z as-is).
  const radius = 10
  verts = verts.map(([x, y, z]) => {
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    return [(x / len) * radius, (y / len) * radius, (z / len) * radius + radius]
  })

  return { verts, faces }
}

export function trianglesToStl(verts, faces) {
  const buf = new ArrayBuffer(84 + faces.length * 50)
  const dv = new DataView(buf)
  let off = 80
  dv.setUint32(off, faces.length, true)
  off += 4
  for (const [i1, i2, i3] of faces) {
    const p1 = verts[i1], p2 = verts[i2], p3 = verts[i3]
    const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2]
    const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2]
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    dv.setFloat32(off, nx / nl, true); off += 4
    dv.setFloat32(off, ny / nl, true); off += 4
    dv.setFloat32(off, nz / nl, true); off += 4
    for (const p of [p1, p2, p3]) {
      dv.setFloat32(off, p[0], true); off += 4
      dv.setFloat32(off, p[1], true); off += 4
      dv.setFloat32(off, p[2], true); off += 4
    }
    dv.setUint16(off, 0, true); off += 2
  }
  return new Uint8Array(buf)
}

// ── WASM module loading (Node) ────────────────────────────────────────────────
// Mirrors the blob-URL trick in src/workers/slicer.worker.ts (Emscripten's
// MODULARIZE output is a CommonJS IIFE, not an ES module) but uses a data:
// URL instead of Blob+createObjectURL, since public/wasm/ sits under this
// project's root package.json ("type": "module") — a plain require()/import
// of the file would make Node parse its CommonJS syntax as ES module syntax
// and fail. A data: URL sidesteps that entirely.
//
// Built with `-sENVIRONMENT=web,worker,node`, slicer.js's own Node-detection
// branch unconditionally does `var fs = require("fs"); ... scriptDirectory =
// __dirname + "/"` whenever it detects Node — but loading it as a real ES
// module (which the data: URL trick does) means `require`/`__dirname` don't
// exist as module-scope bindings, so a bare reference to either throws
// ReferenceError before the factory ever runs. Polyfilling them as globals
// works because an unresolved bare identifier in any script/module falls
// back to a same-named own property on globalThis. We supply wasmBinary
// directly below, so the actual fs/path calls this unlocks are never
// exercised — only the unconditional `__dirname + "/"` assignment needs to
// not throw.
globalThis.require ??= createRequire(import.meta.url)
globalThis.__dirname ??= '.'
globalThis.__filename ??= ''

export async function loadModule(wasmDir, engine) {
  const jsPath = resolve(wasmDir, `${engine}.js`)
  const wasmPath = resolve(wasmDir, `${engine}.wasm`)
  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    throw new Error(`${engine}.js/${engine}.wasm not found in ${wasmDir} — build (build-wasm.yml) or download (npm run setup) the engine first`)
  }
  const jsText = readFileSync(jsPath, 'utf8')
  const wasmBinary = readFileSync(wasmPath)
  const dataUrl = 'data:text/javascript;charset=utf-8,' +
    encodeURIComponent(`${jsText}\nexport default OrcaModule;`)
  const { default: factory } = await import(dataUrl)
  return factory({
    wasmBinary,
    // mt builds spawn pthread workers via `new Worker(pthreadMainJs, ...)`,
    // where pthreadMainJs defaults to `_scriptName`, which Node's shell.js
    // resolves from `__filename` — but that's polyfilled to '' above (only
    // so the unconditional `__dirname + "/"` assignment doesn't throw), so
    // without this override Node's Worker constructor rejects the empty
    // path with ERR_WORKER_PATH. Same fix as src/workers/slicer.worker.ts
    // uses for the browser build: hand Emscripten the real script path
    // directly via the officially-supported override instead of relying on
    // the __filename fallback. Harmless no-op for st (non-pthread) builds,
    // whose output has no code path that reads this option.
    mainScriptUrlOrBlob: jsPath,
    printErr: (m) => console.warn('[OrcaWASM]', m),
    onAbort: (m) => { throw new Error(`WASM module aborted: ${m}`) },
  })
}

// ── minimal heap marshaling ────────────────────────────────────────────────────
// Deliberately duplicated (in miniature) from src/lib/wasm-loader.ts rather
// than imported — this runs as plain Node ESM with no TS build step, and
// wasm-loader.ts is TypeScript.

export function writeBytes(module, bytes) {
  const ptr = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, ptr)
  return ptr
}

export function decodeError(module, session) {
  try {
    const ptr = module._orc_decode_exception(session)
    return ptr ? module.UTF8ToString(ptr) : '(no message)'
  } catch {
    return '(failed to decode error)'
  }
}

export function initSession(module, session, configJson) {
  const configBytes = new TextEncoder().encode(configJson)
  const configPtr = writeBytes(module, configBytes)
  const rc = module._orc_init(session, configPtr, configBytes.length)
  module._free(configPtr)
  if (rc !== 0) throw new Error(`orc_init failed (${rc}): ${decodeError(module, session)}`)
}

export function sliceOnce(module, session, stlBytes) {
  const stlPtr = writeBytes(module, stlBytes)
  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)
  const rc = module._orc_slice(session, stlPtr, stlBytes.length, outPtrPtr, outLenPtr)
  module._free(stlPtr)
  if (rc !== 0) {
    const msg = decodeError(module, session)
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new Error(`orc_slice failed (${rc}): ${msg}`)
  }
  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)
  module._orc_free(gcodePtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)
  return gcode
}

export function sliceMultiOnce(module, session, stlBytesArr, extruderIds) {
  const totalLen = stlBytesArr.reduce((sum, b) => sum + b.length, 0)
  const combined = new Uint8Array(totalLen)
  const offsets = new Int32Array(stlBytesArr.length * 2)
  let pos = 0
  for (let i = 0; i < stlBytesArr.length; i++) {
    combined.set(stlBytesArr[i], pos)
    offsets[i * 2] = pos
    offsets[i * 2 + 1] = stlBytesArr[i].length
    pos += stlBytesArr[i].length
  }
  const dataPtr = writeBytes(module, combined)
  const offsetsPtr = module._malloc(offsets.length * 4)
  for (let i = 0; i < offsets.length; i++) module.setValue(offsetsPtr + i * 4, offsets[i], 'i32')

  let extruderIdsPtr = 0
  if (extruderIds) {
    extruderIdsPtr = module._malloc(extruderIds.length * 4)
    for (let i = 0; i < extruderIds.length; i++) module.setValue(extruderIdsPtr + i * 4, extruderIds[i], 'i32')
  }

  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)
  const rc = module._orc_slice_multi(
    session, dataPtr, combined.length, offsetsPtr, stlBytesArr.length, extruderIdsPtr, outPtrPtr, outLenPtr,
  )
  module._free(dataPtr)
  module._free(offsetsPtr)
  if (extruderIdsPtr) module._free(extruderIdsPtr)
  if (rc !== 0) {
    const msg = decodeError(module, session)
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new Error(`orc_slice_multi failed (${rc}): ${msg}`)
  }
  const gcodePtr = module.getValue(outPtrPtr, 'i32')
  const gcodeLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)
  module._orc_free(gcodePtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)
  return gcode
}
