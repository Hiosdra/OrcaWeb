#!/usr/bin/env node
/**
 * WASM engine smoke test.
 *
 * Loads the built slicer.js/slicer.wasm and runs several real orc_init +
 * orc_slice(_multi) calls end-to-end, so a broken engine build is caught
 * before it's ever published as a GitHub Release (build-wasm.yml) or
 * trusted by local `npm run dev` after `npm run setup`.
 *
 * This formalizes the ad-hoc reproduction script referenced (but never
 * committed) in orca-wasm/wasm/CMakeLists.txt's --profiling-funcs comment,
 * which was used to root-cause the Voron Cube wall-generator crash — a
 * build that compiles fine can still trap on a real slice, and nobody
 * noticed until a live user's browser session failed.
 *
 * Usage:
 *   node orca-wasm/scripts/smoke-test.mjs [--wasm-dir public/wasm] [--fixture path/to.stl]
 *
 * Without --fixture, a synthetic torture-test mesh (a subdivided
 * icosphere, ~1280 triangles) is generated in memory. Deliberately not
 * vendoring a third-party STL (e.g. Voron Design's cube) here — that
 * sidesteps any question about redistributing someone else's model inside
 * this repo, keeps the script runnable fully offline, and adds zero repo
 * bloat. Pass --fixture with a real STL for a closer repro of a specific
 * historical crash (that STL is never committed by this script either).
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wasmDir: 'public/wasm', fixture: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wasm-dir') args.wasmDir = argv[++i]
    else if (argv[i] === '--fixture') args.fixture = argv[++i]
  }
  return args
}

// ── synthetic torture-test mesh (subdivided icosphere) ───────────────────────

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

  // Normalize to unit sphere, scale to a 10mm-radius solid, lift so min z = 0
  // (matches how the real bridge expects/centers a model — see orc_slice's
  // center_around_origin() call, which handles X/Y but leaves Z as-is).
  const radius = 10
  verts = verts.map(([x, y, z]) => {
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    return [(x / len) * radius, (y / len) * radius, (z / len) * radius + radius]
  })

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

function generateTortureStl() {
  const { verts, faces } = icosphere(4) // 20 * 4^4 = 5120 triangles
  return trianglesToStl(verts, faces)
}

// ── WASM module loading (Node) ────────────────────────────────────────────────
// Mirrors the blob-URL trick in src/workers/slicer.worker.ts (Emscripten's
// MODULARIZE output is a CommonJS IIFE, not an ES module) but uses a data:
// URL instead of Blob+createObjectURL, since public/wasm/ sits under this
// project's root package.json ("type": "module") — a plain require()/import
// of the file would make Node parse its CommonJS syntax as ES module syntax
// and fail. A data: URL sidesteps that entirely.

async function loadModule(wasmDir) {
  const jsPath = resolve(wasmDir, 'slicer.js')
  const wasmPath = resolve(wasmDir, 'slicer.wasm')
  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    throw new Error(`slicer.js/slicer.wasm not found in ${wasmDir} — build (build-wasm.yml) or download (npm run setup) the engine first`)
  }
  const jsText = readFileSync(jsPath, 'utf8')
  const wasmBinary = readFileSync(wasmPath)
  const dataUrl = 'data:text/javascript;charset=utf-8,' +
    encodeURIComponent(`${jsText}\nexport default OrcaModule;`)
  const { default: factory } = await import(dataUrl)
  return factory({
    wasmBinary,
    printErr: (m) => console.warn('[OrcaWASM]', m),
    onAbort: (m) => { throw new Error(`WASM module aborted: ${m}`) },
  })
}

// ── minimal heap marshaling ────────────────────────────────────────────────────
// Deliberately duplicated (in miniature) from src/lib/wasm-loader.ts rather
// than imported — this script runs as plain Node ESM with no TS build step,
// and wasm-loader.ts is TypeScript.

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

function sliceMultiOnce(module, session, stlBytesArr, extruderIds) {
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

// ── sanity assertions on the resulting G-code ─────────────────────────────────

function assertSaneGcode(gcode, label) {
  if (!gcode || gcode.length < 200) throw new Error(`${label}: G-code suspiciously short/empty (${gcode?.length ?? 0} bytes)`)
  if (!/^G1 |\nG1 /.test(gcode)) throw new Error(`${label}: no G1 extrusion moves found`)
  const lines = gcode.split('\n').length
  if (lines < 50) throw new Error(`${label}: only ${lines} lines — expected a real multi-layer slice`)
}

// ── real base config (Generic-ish printer + PLA + Standard) ───────────────────
// Deliberately not importing src/lib/profiles.ts (TS + depends on the bundled
// orca-profiles.json shape); a minimal but real, representative config is
// enough to exercise the engine the same way the app's default preset does.

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
  const { wasmDir, fixture } = parseArgs(process.argv.slice(2))
  console.log(`[smoke-test] loading engine from ${wasmDir}...`)
  const module = await loadModule(wasmDir)
  console.log('[smoke-test] engine loaded')

  const stlBytes = fixture ? readFileSync(fixture) : generateTortureStl()
  console.log(`[smoke-test] test mesh: ${fixture ?? '<synthetic icosphere, ~5120 tris>'} (${stlBytes.length} bytes)`)

  const session = module._orc_session_create()
  if (!session) throw new Error('orc_session_create failed (allocation failure)')

  const scenarios = [
    {
      name: 'default (Arachne walls, no fuzzy skin)',
      config: BASE_CONFIG,
    },
    {
      name: 'fuzzy skin = all',
      config: { ...BASE_CONFIG, fuzzy_skin: 'all', fuzzy_skin_thickness: 0.3, fuzzy_skin_point_dist: 0.8 },
    },
    {
      name: 'classic wall generator (regression control vs. Arachne default)',
      config: { ...BASE_CONFIG, wall_generator: 'classic' },
    },
  ]

  let failures = 0
  for (const scenario of scenarios) {
    process.stdout.write(`[smoke-test] ${scenario.name} ... `)
    try {
      initSession(module, session, JSON.stringify(scenario.config))
      const gcode = sliceOnce(module, session, stlBytes)
      assertSaneGcode(gcode, scenario.name)
      console.log(`PASS (${gcode.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }
  }

  // Multi-object plate with a per-object "extruder" override (same value on
  // both objects — a real physical-multi-nozzle config is NOT exercised
  // here; nozzle_diameter stays length-1, so this never enters the
  // support_different_extruders() code path). This specifically probes the
  // orc_slice_multi extruder_ids plumbing added alongside the session-handle
  // refactor, not multi-nozzle machine support (see isMultiExtruderProfile()
  // in src/lib/profiles.ts and mkdocs-docs/adr/adr-008-session-handle.md for
  // why real multi-nozzle configs remain gated off pending a debug-build
  // root-cause session this script cannot perform).
  process.stdout.write('[smoke-test] plate: 2 objects, per-object extruder override (single nozzle) ... ')
  try {
    initSession(module, session, JSON.stringify(BASE_CONFIG))
    const gcode = sliceMultiOnce(module, session, [stlBytes, stlBytes], Int32Array.from([1, 1]))
    assertSaneGcode(gcode, 'plate/extruder-ids')
    console.log(`PASS (${gcode.length} bytes)`)
  } catch (err) {
    failures++
    console.log('FAIL')
    console.error(`  ${err.message}`)
  }

  module._orc_session_destroy(session)

  if (failures > 0) {
    console.error(`\n[smoke-test] ${failures} scenario(s) failed`)
    process.exit(1)
  }
  console.log('\n[smoke-test] all scenarios passed')
}

main().catch((err) => {
  console.error('[smoke-test] fatal:', err.stack ?? err)
  process.exit(1)
})
