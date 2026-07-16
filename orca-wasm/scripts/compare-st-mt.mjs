#!/usr/bin/env node
/**
 * ST vs MT G-code equivalence check (see ADR-011).
 *
 * Slices a fixed set of meshes through both engine variants — slicer.js
 * (single-threaded, orca-wasm/wasm/shims/ header stubs) and slicer-mt.js
 * (multithreaded, real oneTBB + Emscripten pthreads) — with identical
 * configs, and compares the resulting G-code. Real parallelism can reorder
 * floating-point reductions (see ADR-011), so this deliberately does NOT
 * require byte-equal output: it requires an identical toolpath *structure*
 * (same layer count, same number of G0/G1 moves, same move types in the
 * same order) with G0/G1 coordinates matching within a small numeric
 * tolerance.
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
import {
  trianglesToStl, sphereStl, loadModule, writeBytes, decodeError,
  initSession, sliceOnce, sliceMultiOnce,
} from './lib/engine-harness.mjs'

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
// A fixed set of STLs (small cube, a >100k-triangle organic mesh, a
// multi-object plate through orc_slice_multi) — see ADR-011.
// sphereStl()/trianglesToStl() live in ./lib/engine-harness.mjs.

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

// ── engine harness ──────────────────────────────────────────────────────────
// loadModule() + orc_* heap marshaling live in ./lib/engine-harness.mjs.

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
    const cleanLine = line.split(';', 1)[0].trim()
    const m = cleanLine.match(/^(G[01])\s+(.*)/)
    if (!m) continue
    const [, cmd, rest] = m
    const xm = rest.match(/X(-?[0-9.]+)/)
    const ym = rest.match(/Y(-?[0-9.]+)/)
    const zm = rest.match(/Z(-?[0-9.]+)/)
    const em = rest.match(/E(-?[0-9.]+)/)
    if (!xm && !ym && !zm && !em) continue
    if (xm) x = parseFloat(xm[1])
    if (ym) y = parseFloat(ym[1])
    if (zm) z = parseFloat(zm[1])
    if (em) e = parseFloat(em[1])
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
      if ((av === undefined) !== (bv === undefined)) {
        return `move ${i} (${a.cmd}): ${axis.toUpperCase()} presence differs`
      }
      if (av === undefined) continue
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
