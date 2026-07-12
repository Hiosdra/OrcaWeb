#!/usr/bin/env node
/**
 * ST vs MT G-code equivalence check (orca-wasm/MT-PLAN.md Phase 4, item 1).
 *
 * Slices a fixed set of meshes through both engine variants — slicer.js
 * (single-threaded, shims/) and slicer-mt.js (multithreaded, shims-mt/,
 * real pthreads) — with identical configs, and compares the resulting
 * G-code. Real parallelism can reorder floating-point reductions (see
 * MT-PLAN.md Phase 1c), so this deliberately does NOT require byte-equal
 * output: it requires an identical toolpath *structure* (same layer count,
 * same number of G0/G1 moves, same move types in the same order) with
 * G0/G1 coordinates matching within a small numeric tolerance.
 *
 * Requires both engines already built/downloaded into --wasm-dir (default
 * public/wasm/) — this does not build or fetch them itself. In CI, run
 * after both build-wasm.yml matrix legs have published, with both artifact
 * sets downloaded into the same directory.
 *
 * Usage:
 *   node orca-wasm/scripts/compare-st-mt.mjs [--wasm-dir public/wasm] [--tolerance 0.01]
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wasmDir: 'public/wasm', tolerance: 0.01 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wasm-dir') args.wasmDir = argv[++i]
    else if (argv[i] === '--tolerance') args.tolerance = Number(argv[++i])
  }
  return args
}

// ── test meshes ──────────────────────────────────────────────────────────────
// Per MT-PLAN.md Phase 4 item 1: "a fixed set of STLs (small cube, a
// >100k-triangle organic mesh, a multi-object plate through orc_slice_multi)".
// Generated in memory (no repo bloat, fully offline) — same icosphere
// generator as smoke-test.mjs, duplicated rather than imported for the same
// reason smoke-test.mjs gives for its own duplication from wasm-loader.ts:
// this is plain Node ESM with no TS build step and no other caller (yet) to
// justify a shared module.

function icosphere(subdivisions) {
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

  return { verts, faces }
}

function trianglesToStl(verts, faces) {
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

function sphereStl(subdivisions, radiusMm) {
  const { verts, faces } = icosphere(subdivisions)
  const scaled = verts.map(([x, y, z]) => {
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    return [(x / len) * radiusMm, (y / len) * radiusMm, (z / len) * radiusMm + radiusMm]
  })
  return trianglesToStl(scaled, faces)
}

function cubeStl(sizeMm) {
  const s = sizeMm
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [1, 2, 6], [1, 6, 5], // right
    [2, 3, 7], [2, 7, 6], // back
    [3, 0, 4], [3, 4, 7], // left
  ]
  return trianglesToStl(v, faces)
}

const MESHES = {
  'small cube (20mm)': () => cubeStl(20),
  // subdivisions=7 -> 20 * 4^7 = 327,680 triangles, comfortably over the
  // >100k-triangle bar Phase 4 asks for.
  'organic mesh (~328k tris)': () => sphereStl(7, 15),
}

// ── WASM module loading (Node) ────────────────────────────────────────────────
// See smoke-test.mjs for why this shape (data: URL + require/__dirname
// polyfills) is needed instead of a plain import().

globalThis.require ??= createRequire(import.meta.url)
globalThis.__dirname ??= '.'
globalThis.__filename ??= ''

async function loadModule(wasmDir, engine) {
  const jsPath = resolve(wasmDir, `${engine}.js`)
  const wasmPath = resolve(wasmDir, `${engine}.wasm`)
  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    throw new Error(`${engine}.js/${engine}.wasm not found in ${wasmDir}`)
  }
  const jsText = readFileSync(jsPath, 'utf8')
  const wasmBinary = readFileSync(wasmPath)
  const dataUrl = 'data:text/javascript;charset=utf-8,' +
    encodeURIComponent(`${jsText}\nexport default OrcaModule;`)
  const { default: factory } = await import(dataUrl)
  return factory({
    wasmBinary,
    // See smoke-test.mjs's loadModule() for why this is required for mt:
    // Node's pthread worker spawn defaults to `_scriptName` (derived from
    // the polyfilled, empty __filename above), which throws ERR_WORKER_PATH.
    mainScriptUrlOrBlob: jsPath,
    printErr: (m) => console.warn(`[OrcaWASM/${engine}]`, m),
    onAbort: (m) => { throw new Error(`WASM module (${engine}) aborted: ${m}`) },
  })
}

// ── minimal heap marshaling (duplicated from smoke-test.mjs) ─────────────────

function writeBytes(module, bytes) {
  const ptr = module._malloc(bytes.length)
  module.HEAPU8.set(bytes, ptr)
  return ptr
}

function decodeError(module, session) {
  try {
    const ptr = module._orc_decode_exception(session)
    return ptr ? module.UTF8ToString(ptr) : '(no message)'
  } catch {
    return '(failed to decode error)'
  }
}

function initSession(module, session, configJson) {
  const configBytes = new TextEncoder().encode(configJson)
  const configPtr = writeBytes(module, configBytes)
  const rc = module._orc_init(session, configPtr, configBytes.length)
  module._free(configPtr)
  if (rc !== 0) throw new Error(`orc_init failed (${rc}): ${decodeError(module, session)}`)
}

function sliceOnce(module, session, stlBytes) {
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

function sliceMultiOnce(module, session, stlBytesArr) {
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
  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)
  const rc = module._orc_slice_multi(
    session, dataPtr, combined.length, offsetsPtr, stlBytesArr.length, 0, outPtrPtr, outLenPtr,
  )
  module._free(dataPtr)
  module._free(offsetsPtr)
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

// ── G-code structural comparison ──────────────────────────────────────────────
// Layer count: same "; total layers count = N" comment the app itself reads
// (see src/components/SlicePanel.tsx), falling back to counting
// ;LAYER_CHANGE markers exactly like that same component does, so this
// script's notion of "layer count" always matches what a user would see.

function layerCount(gcode) {
  const m = gcode.match(/;\s*total layers count\s*=\s*(\d+)/i)
  if (m) return Number(m[1])
  return (gcode.match(/;LAYER_CHANGE/g) ?? []).length
}

// Every G0/G1 move, in order, as {cmd, x, y, z, e} (fields absent from a
// given line are carried forward from the previous move, matching G-code's
// modal-coordinate semantics — comparing raw per-line values without this
// would flag every line that only changes one axis as a "structural"
// mismatch against a variant that happened to also restate the others).
function extractMoves(gcode) {
  const moves = []
  let x, y, z, e
  for (const line of gcode.split('\n')) {
    const m = line.match(/^(G[01])\s+(.*)/)
    if (!m) continue
    const [, cmd, rest] = m
    const xm = rest.match(/X(-?[0-9.]+)/); if (xm) x = parseFloat(xm[1])
    const ym = rest.match(/Y(-?[0-9.]+)/); if (ym) y = parseFloat(ym[1])
    const zm = rest.match(/Z(-?[0-9.]+)/); if (zm) z = parseFloat(zm[1])
    const em = rest.match(/E(-?[0-9.]+)/); if (em) e = parseFloat(em[1])
    moves.push({ cmd, x, y, z, e })
  }
  return moves
}

// Returns null on structural equivalence, or a description of the first
// divergence found.
function compareGcode(stGcode, mtGcode, tolerance) {
  const stLayers = layerCount(stGcode)
  const mtLayers = layerCount(mtGcode)
  if (stLayers !== mtLayers) {
    return `layer count differs: st=${stLayers} mt=${mtLayers}`
  }
  if (stLayers === 0) {
    return 'layer count is 0 on both — G-code parsing likely broken, not a real pass'
  }

  const stMoves = extractMoves(stGcode)
  const mtMoves = extractMoves(mtGcode)
  if (stMoves.length !== mtMoves.length) {
    return `move count differs: st=${stMoves.length} mt=${mtMoves.length}`
  }

  let maxDelta = 0
  for (let i = 0; i < stMoves.length; i++) {
    const a = stMoves[i], b = mtMoves[i]
    if (a.cmd !== b.cmd) return `move ${i}: command differs (st=${a.cmd} mt=${b.cmd})`
    for (const axis of ['x', 'y', 'z', 'e']) {
      const av = a[axis], bv = b[axis]
      if (av === undefined || bv === undefined) continue
      const delta = Math.abs(av - bv)
      if (delta > tolerance) {
        return `move ${i} (${a.cmd}): ${axis.toUpperCase()} differs beyond tolerance ` +
          `(st=${av} mt=${bv}, delta=${delta.toFixed(4)} > ${tolerance})`
      }
      maxDelta = Math.max(maxDelta, delta)
    }
  }
  return { ok: true, layers: stLayers, moves: stMoves.length, maxDelta }
}

// ── real base config (same as smoke-test.mjs) ─────────────────────────────────

const BASE_CONFIG = {
  bed_size_x: 256,
  bed_size_y: 256,
  printable_height: 250,
  nozzle_diameter: 0.4,
  layer_height: 0.2,
  initial_layer_height: 0.2,
  wall_loops: 2,
  top_shell_layers: 3,
  bottom_shell_layers: 3,
  sparse_infill_density: 15,
  sparse_infill_pattern: 'grid',
  filament_type: 'PLA',
  nozzle_temperature: 220,
  bed_temperature: 55,
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { wasmDir, tolerance } = parseArgs(process.argv.slice(2))
  console.log(`[compare-st-mt] loading st + mt engines from ${wasmDir} (tolerance=${tolerance}mm)...`)
  const st = await loadModule(wasmDir, 'slicer')
  const mt = await loadModule(wasmDir, 'slicer-mt')
  console.log('[compare-st-mt] both engines loaded')

  const stSession = st._orc_session_create()
  const mtSession = mt._orc_session_create()
  if (!stSession || !mtSession) throw new Error('orc_session_create failed (allocation failure)')

  let failures = 0

  for (const [label, makeStl] of Object.entries(MESHES)) {
    const stlBytes = makeStl()
    process.stdout.write(`[compare-st-mt] ${label} (${stlBytes.length} bytes) ... `)
    try {
      initSession(st, stSession, JSON.stringify(BASE_CONFIG))
      initSession(mt, mtSession, JSON.stringify(BASE_CONFIG))
      const stGcode = sliceOnce(st, stSession, stlBytes)
      const mtGcode = sliceOnce(mt, mtSession, stlBytes)
      const result = compareGcode(stGcode, mtGcode, tolerance)
      if (typeof result === 'string') {
        failures++
        console.log('FAIL')
        console.error(`  ${result}`)
      } else {
        console.log(`PASS (${result.layers} layers, ${result.moves} moves, max delta ${result.maxDelta.toFixed(5)}mm)`)
      }
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }
  }

  // Multi-object plate through orc_slice_multi (Phase 4 item 1's third case).
  const plateLabel = 'plate: 2x small cube via orc_slice_multi'
  process.stdout.write(`[compare-st-mt] ${plateLabel} ... `)
  try {
    const cube = cubeStl(20)
    initSession(st, stSession, JSON.stringify(BASE_CONFIG))
    initSession(mt, mtSession, JSON.stringify(BASE_CONFIG))
    const stGcode = sliceMultiOnce(st, stSession, [cube, cube])
    const mtGcode = sliceMultiOnce(mt, mtSession, [cube, cube])
    const result = compareGcode(stGcode, mtGcode, tolerance)
    if (typeof result === 'string') {
      failures++
      console.log('FAIL')
      console.error(`  ${result}`)
    } else {
      console.log(`PASS (${result.layers} layers, ${result.moves} moves, max delta ${result.maxDelta.toFixed(5)}mm)`)
    }
  } catch (err) {
    failures++
    console.log('FAIL')
    console.error(`  ${err.message}`)
  }

  st._orc_session_destroy(stSession)
  mt._orc_session_destroy(mtSession)

  if (failures > 0) {
    console.error(`\n[compare-st-mt] ${failures} scenario(s) diverged`)
    process.exit(1)
  }
  console.log('\n[compare-st-mt] st and mt engines produce structurally equivalent G-code')
}

main().catch((err) => {
  console.error('[compare-st-mt] fatal:', err.stack ?? err)
  process.exit(1)
})
