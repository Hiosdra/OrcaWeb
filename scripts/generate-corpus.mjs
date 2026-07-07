#!/usr/bin/env node
/**
 * Generates a reproducible G-code corpus for the compression benchmark
 * (mkdocs-docs/gcode-compression-benchmark.md) by slicing procedurally
 * generated meshes with the real OrcaWeb WASM engine.
 *
 * Procedural meshes rather than a downloaded/vendored STL set (e.g. 3DBenchy)
 * for the same reason orca-wasm/scripts/smoke-test.mjs avoids vendoring one:
 * no third-party redistribution question, fully reproducible offline once
 * the WASM engine is present, zero repo bloat. See manifest.json (written
 * alongside the output) for the exact parameters behind each file.
 *
 * Usage:
 *   node scripts/generate-corpus.mjs [--wasm-dir public/wasm] [--out-dir <dir>]
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

globalThis.require ??= createRequire(import.meta.url)
globalThis.__dirname ??= '.'
globalThis.__filename ??= ''

function parseArgs(argv) {
  const args = { wasmDir: 'public/wasm', outDir: 'corpus' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wasm-dir') args.wasmDir = argv[++i]
    else if (argv[i] === '--out-dir') args.outDir = argv[++i]
  }
  return args
}

// ── mesh generators ───────────────────────────────────────────────────────────

function trianglesToStl(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const dv = new DataView(buf)
  let off = 80
  dv.setUint32(off, tris.length, true)
  off += 4
  for (const [p1, p2, p3] of tris) {
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

// Subdivided icosahedron — a rounded, all-angles organic torture mesh (same
// generator family as smoke-test.mjs, parameterized here by radius/subdivisions
// to stand in for "small/medium/large organic part" corpus entries.
function icosphereTris(subdivisions, radius, zLift) {
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
  verts = verts.map(([x, y, z]) => {
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    return [(x / len) * radius, (y / len) * radius, (z / len) * radius + zLift]
  })
  return faces.map(([i1, i2, i3]) => [verts[i1], verts[i2], verts[i3]])
}

// Axis-aligned cube — the calibration-cube corpus entry.
function cubeTris(size) {
  const s = size
  const p = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
  const quads = [
    [0, 1, 2, 3], // bottom
    [4, 7, 6, 5], // top
    [0, 4, 5, 1], // front
    [1, 5, 6, 2], // right
    [2, 6, 7, 3], // back
    [3, 7, 4, 0], // left
  ]
  const tris = []
  for (const [a, b, c, d] of quads) {
    tris.push([p[a], p[b], p[c]], [p[a], p[c], p[d]])
  }
  return tris
}

// Open-top truncated cone (no top cap) — a vase-mode-friendly single-wall
// shape: spiral vase printing needs a continuous outer wall and an open top.
function vaseConeTris(bottomRadius, topRadius, height, segments) {
  const bottomRing = []
  const topRing = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    bottomRing.push([Math.cos(a) * bottomRadius, Math.sin(a) * bottomRadius, 0])
    topRing.push([Math.cos(a) * topRadius, Math.sin(a) * topRadius, height])
  }
  const tris = []
  // side walls
  for (let i = 0; i < segments; i++) {
    const ni = (i + 1) % segments
    tris.push([bottomRing[i], bottomRing[ni], topRing[i]])
    tris.push([topRing[i], bottomRing[ni], topRing[ni]])
  }
  // bottom cap (fan)
  const center = [0, 0, 0]
  for (let i = 0; i < segments; i++) {
    const ni = (i + 1) % segments
    tris.push([center, bottomRing[ni], bottomRing[i]])
  }
  return tris
}

// ── WASM loading (mirrors smoke-test.mjs) ────────────────────────────────────

async function loadModule(wasmDir) {
  const jsPath = resolve(wasmDir, 'slicer.js')
  const wasmPath = resolve(wasmDir, 'slicer.wasm')
  if (!existsSync(jsPath) || !existsSync(wasmPath)) {
    throw new Error(`slicer.js/slicer.wasm not found in ${wasmDir}`)
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

// ── base profile (matches orca-wasm/scripts/smoke-test.mjs's representative config) ──

const BASE_PROFILE = {
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

// ── corpus manifest ──────────────────────────────────────────────────────────
// Deliberately a single engine build / single gcode flavor (the engine's
// default) for this run — see the benchmark doc's "Deviations from the
// original plan" section for why the Marlin/Klipper flavor split was
// descoped.

const CORPUS = [
  {
    id: 'calibration_cube',
    label: 'Calibration cube (20mm)',
    mesh: () => cubeTris(20),
    profile: BASE_PROFILE,
  },
  {
    id: 'small_organic',
    label: 'Small organic part (icosphere, subdiv 2, r=12mm)',
    mesh: () => icosphereTris(2, 12, 12),
    profile: BASE_PROFILE,
  },
  {
    id: 'medium_organic',
    label: 'Medium organic part (icosphere, subdiv 3, r=30mm)',
    mesh: () => icosphereTris(3, 30, 30),
    profile: BASE_PROFILE,
  },
  {
    id: 'vase_mode',
    label: 'Vase-mode cone (open top, single wall, spiral_mode)',
    mesh: () => vaseConeTris(35, 15, 120, 64),
    profile: { ...BASE_PROFILE, wall_loops: 1, top_shell_layers: 0, bottom_shell_layers: 1, sparse_infill_density: 0, spiral_mode: true },
  },
  {
    id: 'large_functional',
    label: 'Large functional part (icosphere, subdiv 4, r=45mm, dense settings)',
    mesh: () => icosphereTris(4, 45, 45),
    profile: { ...BASE_PROFILE, layer_height: 0.12, initial_layer_height: 0.12, wall_loops: 3, top_shell_layers: 5, bottom_shell_layers: 5, sparse_infill_density: 30 },
  },
]

async function main() {
  const { wasmDir, outDir } = parseArgs(process.argv.slice(2))
  mkdirSync(outDir, { recursive: true })

  console.log(`[generate-corpus] loading engine from ${wasmDir}...`)
  const module = await loadModule(wasmDir)
  const session = module._orc_session_create()
  if (!session) throw new Error('orc_session_create failed')

  const manifest = { engine: 'OrcaWeb WASM (wasm-v2.4.0-patch5)', generatedAt: new Date().toISOString(), models: [] }

  for (const entry of CORPUS) {
    process.stdout.write(`[generate-corpus] ${entry.id} ... `)
    const t0 = Date.now()
    const tris = entry.mesh()
    const stlBytes = trianglesToStl(tris)
    let gcode
    try {
      initSession(module, session, JSON.stringify(entry.profile))
      gcode = sliceOnce(module, session, stlBytes)
    } catch (err) {
      // spiral_mode may be rejected by this engine build depending on config
      // validation; fall back to the profile without it rather than losing
      // the whole corpus entry.
      if (entry.profile.spiral_mode) {
        console.log(`spiral_mode rejected (${err.message}), retrying without it...`)
        const fallback = { ...entry.profile }
        delete fallback.spiral_mode
        initSession(module, session, JSON.stringify(fallback))
        gcode = sliceOnce(module, session, stlBytes)
      } else {
        throw err
      }
    }
    const outPath = resolve(outDir, `${entry.id}.gcode`)
    writeFileSync(outPath, gcode, 'utf8')
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`${gcode.length.toLocaleString()} bytes, ${gcode.split('\n').length.toLocaleString()} lines (${dt}s)`)
    manifest.models.push({
      id: entry.id, label: entry.label, triangles: tris.length,
      profile: entry.profile, gcodeBytes: gcode.length, gcodeLines: gcode.split('\n').length,
    })
  }

  module._orc_session_destroy(session)
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`[generate-corpus] wrote manifest to ${resolve(outDir, 'manifest.json')}`)
}

main().catch((err) => {
  console.error('[generate-corpus] fatal:', err.stack ?? err)
  process.exit(1)
})
