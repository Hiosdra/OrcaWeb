/**
 * Generates a tiny synthetic binary STL cube in memory for the E2E smoke test.
 *
 * Deliberately not vendoring a third-party model — same rationale as
 * orca-wasm/scripts/smoke-test.mjs's icosphere generator: sidesteps any
 * redistribution/licensing question, keeps the test runnable fully offline,
 * and adds zero repo bloat. A 12-triangle cube is enough to exercise the
 * upload → convert → slice → G-code pipeline through the real UI/worker/WASM
 * path; the WASM engine's own slice-quality coverage lives in that Node
 * script, not here.
 */

const CUBE_FACES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 3], // -Z
  [4, 6, 5], [4, 7, 6], // +Z
  [0, 4, 5], [0, 5, 1], // -Y
  [1, 5, 6], [1, 6, 2], // +X
  [2, 6, 7], [2, 7, 3], // +Y
  [3, 7, 4], [3, 4, 0], // -X
]

function cubeVerts(size: number): readonly (readonly [number, number, number])[] {
  const s = size
  return [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
}

export function cubeStlBuffer(sizeMm = 20): Uint8Array {
  const verts = cubeVerts(sizeMm)
  const buf = new ArrayBuffer(84 + CUBE_FACES.length * 50)
  const dv = new DataView(buf)
  let off = 80
  dv.setUint32(off, CUBE_FACES.length, true)
  off += 4
  for (const [i1, i2, i3] of CUBE_FACES) {
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
