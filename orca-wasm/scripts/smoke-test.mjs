#!/usr/bin/env node
/**
 * WASM engine smoke test.
 *
 * Loads the built slicer.js/slicer.wasm and runs several real orc_init +
 * orc_slice(_multi)/orc_write_3mf/orc_read_3mf calls end-to-end, so a broken
 * engine build is caught before it's ever published as a GitHub Release
 * (build-wasm.yml) or trusted by local `npm run dev` after `npm run setup`.
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
 * Without --fixture, every scenario runs against TWO meshes:
 *   1. A synthetic torture-test mesh (a subdivided icosphere, ~5120
 *      triangles), generated in memory — no redistribution question, runs
 *      fully offline, adds zero repo bloat.
 *   2. The real Voron Design Cube v7 (e2e/fixtures/voron-design-cube-v7.stl,
 *      vendored under GPL-3.0 — see NOTICE.md and ADR-010). This is the
 *      exact real-world mesh that has repeatedly found bugs a synthetic
 *      primitive never would (the Arachne wall-generator crash chain in
 *      apply.py's patches 8/8c/8d/8e/8f, and the Boost.Log default-sink
 *      hang/trap — see the "disable Boost.Log core" fix in
 *      orca-wasm/bridge/slicer.cpp). Skipped with a warning if the fixture
 *      file isn't present (e.g. running this script outside the repo).
 * Pass --fixture to replace both of the above with a single specific STL,
 * for a closer repro of one particular case (that STL is never committed
 * by this script either).
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

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
  // center_object_xy_only() call, which handles X/Y but leaves Z as-is).
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

function write3mfOnce(module, session, stlBytes) {
  const stlPtr = writeBytes(module, stlBytes)
  const outPtrPtr = module._malloc(4)
  const outLenPtr = module._malloc(4)
  const rc = module._orc_write_3mf(session, stlPtr, stlBytes.length, outPtrPtr, outLenPtr)
  module._free(stlPtr)
  if (rc !== 0) {
    const msg = decodeError(module, session)
    module._free(outPtrPtr)
    module._free(outLenPtr)
    throw new Error(`orc_write_3mf failed (${rc}): ${msg}`)
  }
  const dataPtr = module.getValue(outPtrPtr, 'i32')
  const dataLen = module.getValue(outLenPtr, 'i32')
  const data = module.HEAPU8.slice(dataPtr, dataPtr + dataLen)
  module._orc_free(dataPtr)
  module._free(outPtrPtr)
  module._free(outLenPtr)
  return data
}

function read3mfOnce(module, mfBytes) {
  const mfPtr = writeBytes(module, mfBytes)
  const outStlPtrPtr = module._malloc(4)
  const outStlLenPtr = module._malloc(4)
  const outConfigPtrPtr = module._malloc(4)
  const outConfigLenPtr = module._malloc(4)
  const rc = module._orc_read_3mf(mfPtr, mfBytes.length, outStlPtrPtr, outStlLenPtr, outConfigPtrPtr, outConfigLenPtr)
  module._free(mfPtr)
  if (rc !== 0) {
    const msg = decodeError(module, 0)
    module._free(outStlPtrPtr)
    module._free(outStlLenPtr)
    module._free(outConfigPtrPtr)
    module._free(outConfigLenPtr)
    throw new Error(`orc_read_3mf failed (${rc}): ${msg}`)
  }
  const stlPtr = module.getValue(outStlPtrPtr, 'i32')
  const stlLen = module.getValue(outStlLenPtr, 'i32')
  const configPtr = module.getValue(outConfigPtrPtr, 'i32')
  const configLen = module.getValue(outConfigLenPtr, 'i32')
  const stl = module.HEAPU8.slice(stlPtr, stlPtr + stlLen)
  const configJson = module.UTF8ToString(configPtr, configLen)
  module._orc_free(stlPtr)
  module._orc_free(configPtr)
  module._free(outStlPtrPtr)
  module._free(outStlLenPtr)
  module._free(outConfigPtrPtr)
  module._free(outConfigLenPtr)
  return { stl, configJson }
}

// Binary STL: 80-byte header + uint32 triangle count + N * 50 bytes.
function stlTriangleCount(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
}

// Minimal ZIP central-directory reader — deliberately hand-rolled rather than
// pulling in a zip library (e.g. fflate, used for this in src/lib/*.ts): this
// script also runs inside build-wasm.yml's "Smoke test WASM module" step,
// which only sets up Node (actions/setup-node) and never runs `npm install`
// — so no package outside Node's stdlib is resolvable there. Only reads
// filenames from the central directory (no decompression needed for this
// check), and assumes the classic (non-Zip64) EOCD/CD record layout, which is
// what miniz (OrcaSlicer's zip writer) emits for archives this small — Zip64
// records only get written once entry count or size actually exceeds the
// 32-bit fields' range.
function findEndOfCentralDirectory(bytes) {
  const minPos = Math.max(0, bytes.length - 22 - 65535) // EOCD (22B) + max comment (64KB)
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i
    }
  }
  return -1
}

function listZipEntryNames(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) throw new Error('no End Of Central Directory record found')
  const totalEntries = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)

  const names = []
  let pos = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    const sig = dv.getUint32(pos, true)
    if (sig !== 0x02014b50) throw new Error(`bad central directory entry signature at offset ${pos}`)
    const nameLen = dv.getUint16(pos + 28, true)
    const extraLen = dv.getUint16(pos + 30, true)
    const commentLen = dv.getUint16(pos + 32, true)
    const nameStart = pos + 46
    names.push(new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameStart + nameLen)))
    pos = nameStart + nameLen + extraLen + commentLen
  }
  return names
}

// A .3mf is a ZIP; verify it round-trips as one and carries the two pieces
// orc_write_3mf's contract promises: the mesh (3D/3dmodel.model) and the
// embedded OrcaSlicer settings (a Metadata/*.config file — see
// EMBEDDED_PRINT_FILE_FORMAT et al. in bbs_3mf.hpp for why the filename
// isn't a fixed constant).
function assertValid3mf(bytes, label) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`${label}: output does not start with a ZIP (PK) signature`)
  }
  let names
  try {
    names = listZipEntryNames(bytes)
  } catch (err) {
    throw new Error(`${label}: failed to read ZIP central directory: ${err.message}`)
  }
  if (!names.includes('3D/3dmodel.model')) {
    throw new Error(`${label}: missing 3D/3dmodel.model (entries: ${names.join(', ')})`)
  }
  if (!names.some((n) => /^Metadata\/.*\.config$/.test(n))) {
    throw new Error(`${label}: missing a Metadata/*.config file (entries: ${names.join(', ')})`)
  }
}

// ── sanity assertions on the resulting G-code ─────────────────────────────────

function assertSaneGcode(gcode, label) {
  if (!gcode || gcode.length < 200) throw new Error(`${label}: G-code suspiciously short/empty (${gcode?.length ?? 0} bytes)`)
  if (!/^G1 |\nG1 /.test(gcode)) throw new Error(`${label}: no G1 extrusion moves found`)
  const lines = gcode.split('\n').length
  if (lines < 50) throw new Error(`${label}: only ${lines} lines — expected a real multi-layer slice`)
}

// Regression guard for the bug fixed by center_object_xy_only() in
// slicer.cpp: center_around_origin() used to center the mesh on Z too,
// leaving the object floating with its vertical midpoint (not its base) at
// the bed plane. The torture mesh's base sits at z=0 (see icosphere()
// above), so a correctly-placed slice's lowest G0/G1 Z move should land at
// the first layer height, never deep below zero (sunk into the bed) or
// far above it (floating).
function assertRestsOnBed(gcode, label, firstLayerHeight) {
  const zValues = []
  for (const line of gcode.split('\n')) {
    if (!/^G[01] /.test(line)) continue
    const m = line.match(/Z(-?[0-9.]+)/)
    if (m) zValues.push(parseFloat(m[1]))
  }
  if (zValues.length === 0) throw new Error(`${label}: no Z-bearing G0/G1 moves found`)
  const minZ = Math.min(...zValues)
  if (minZ < -0.01) throw new Error(`${label}: minimum Z is ${minZ} — model appears to be sunk below the bed`)
  if (minZ > firstLayerHeight + 0.05) throw new Error(`${label}: minimum Z is ${minZ}, expected ~${firstLayerHeight} — model appears to be floating above the bed`)
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

// ── test meshes ──────────────────────────────────────────────────────────────
// Repo root — this script lives in orca-wasm/scripts/.
const VORON_CUBE_PATH = resolve(import.meta.dirname, '../../e2e/fixtures/voron-design-cube-v7.stl')

function collectMeshes(fixture) {
  if (fixture) {
    return [{ label: fixture, bytes: readFileSync(fixture) }]
  }
  const meshes = [{ label: 'synthetic icosphere (~5120 tris)', bytes: generateTortureStl() }]
  if (existsSync(VORON_CUBE_PATH)) {
    meshes.push({ label: 'Voron Design Cube v7 (real-world)', bytes: readFileSync(VORON_CUBE_PATH) })
  } else {
    console.warn(`[smoke-test] WARN: ${VORON_CUBE_PATH} not found — skipping the real-world mesh`)
  }
  return meshes
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { wasmDir, fixture } = parseArgs(process.argv.slice(2))
  console.log(`[smoke-test] loading engine from ${wasmDir}...`)
  const module = await loadModule(wasmDir)
  console.log('[smoke-test] engine loaded')

  const meshes = collectMeshes(fixture)
  for (const mesh of meshes) {
    console.log(`[smoke-test] mesh: ${mesh.label} (${mesh.bytes.length} bytes)`)
  }

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
  for (const mesh of meshes) {
    for (const scenario of scenarios) {
      const label = `[${mesh.label}] ${scenario.name}`
      process.stdout.write(`[smoke-test] ${label} ... `)
      try {
        initSession(module, session, JSON.stringify(scenario.config))
        const gcode = sliceOnce(module, session, mesh.bytes)
        assertSaneGcode(gcode, label)
        assertRestsOnBed(gcode, label, scenario.config.initial_layer_height)
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
    const plateLabel = `[${mesh.label}] plate: 2 objects, per-object extruder override (single nozzle)`
    process.stdout.write(`[smoke-test] ${plateLabel} ... `)
    try {
      initSession(module, session, JSON.stringify(BASE_CONFIG))
      const gcode = sliceMultiOnce(module, session, [mesh.bytes, mesh.bytes], Int32Array.from([1, 1]))
      assertSaneGcode(gcode, plateLabel)
      assertRestsOnBed(gcode, plateLabel, BASE_CONFIG.initial_layer_height)
      console.log(`PASS (${gcode.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // orc_write_3mf: mesh + embedded config, no plate/gcode data (see
    // orca-wasm/bridge/slicer.cpp doc comment and issue #108's scope notes).
    const write3mfLabel = `[${mesh.label}] write .3mf (mesh + embedded config)`
    process.stdout.write(`[smoke-test] ${write3mfLabel} ... `)
    let written3mf = null
    try {
      initSession(module, session, JSON.stringify(BASE_CONFIG))
      written3mf = write3mfOnce(module, session, mesh.bytes)
      assertValid3mf(written3mf, write3mfLabel)
      console.log(`PASS (${written3mf.length} bytes)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }

    // orc_read_3mf: round-trip the .3mf just written back through the
    // engine's own reader — mesh triangle count and a few config keys must
    // survive (per issue #108's read-path test plan).
    const read3mfLabel = `[${mesh.label}] read .3mf (round-trip mesh + config)`
    process.stdout.write(`[smoke-test] ${read3mfLabel} ... `)
    try {
      if (!written3mf) throw new Error('no .3mf available (write step failed above)')
      const { stl, configJson } = read3mfOnce(module, written3mf)

      const expectedTris = stlTriangleCount(mesh.bytes)
      const actualTris = stlTriangleCount(stl)
      if (actualTris !== expectedTris) {
        throw new Error(`triangle count mismatch: expected ${expectedTris}, got ${actualTris}`)
      }

      const config = JSON.parse(configJson)
      for (const key of ['layer_height', 'nozzle_temperature', 'filament_type', 'sparse_infill_density']) {
        if (!(key in config)) throw new Error(`config key "${key}" missing from round-tripped .3mf (keys: ${Object.keys(config).join(', ')})`)
      }
      if (parseFloat(config.layer_height) !== BASE_CONFIG.layer_height) {
        throw new Error(`layer_height mismatch: expected ${BASE_CONFIG.layer_height}, got ${config.layer_height}`)
      }

      console.log(`PASS (${actualTris} tris, ${Object.keys(config).length} config keys)`)
    } catch (err) {
      failures++
      console.log('FAIL')
      console.error(`  ${err.message}`)
    }
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
