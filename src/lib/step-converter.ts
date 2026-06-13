import initOcctImport from 'occt-import-js'
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OcctInstance = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _occt: Promise<any> | null = null

function getOcct(): Promise<OcctInstance> {
  return (_occt ??= initOcctImport({ locateFile: () => occtWasmUrl }))
}

export async function cadToStl(filename: string, buffer: ArrayBuffer): Promise<Uint8Array> {
  const occt = await getOcct()
  const data = new Uint8Array(buffer)

  const isIges = /\.(iges|igs)$/i.test(filename)
  const result: { success: boolean; meshes: OcctInstance[] } = isIges
    ? occt.ReadIgesFile(data, null)
    : occt.ReadStepFile(data, null)

  if (!result.success || result.meshes.length === 0) {
    throw new Error(`Failed to parse ${isIges ? 'IGES' : 'STEP'} file`)
  }

  return meshesToBinaryStl(result.meshes)
}

function meshesToBinaryStl(meshes: OcctInstance[]): Uint8Array {
  let totalTriangles = 0
  for (const mesh of meshes) {
    totalTriangles += (mesh.triangles as Uint32Array).length / 3
  }

  // Binary STL: 80-byte header + 4-byte count + 50 bytes per triangle
  const buf = new ArrayBuffer(84 + totalTriangles * 50)
  const view = new DataView(buf)
  view.setUint32(80, totalTriangles, true)

  let offset = 84
  for (const mesh of meshes) {
    const v = mesh.vertices as Float64Array
    const t = mesh.triangles as Uint32Array

    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3
      const b = t[i + 1] * 3
      const c = t[i + 2] * 3

      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]
      const nx = uy * wz - uz * wy
      const ny = uz * wx - ux * wz
      const nz = ux * wy - uy * wx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1

      view.setFloat32(offset, nx / len, true); offset += 4
      view.setFloat32(offset, ny / len, true); offset += 4
      view.setFloat32(offset, nz / len, true); offset += 4
      view.setFloat32(offset, v[a],     true); offset += 4
      view.setFloat32(offset, v[a + 1], true); offset += 4
      view.setFloat32(offset, v[a + 2], true); offset += 4
      view.setFloat32(offset, v[b],     true); offset += 4
      view.setFloat32(offset, v[b + 1], true); offset += 4
      view.setFloat32(offset, v[b + 2], true); offset += 4
      view.setFloat32(offset, v[c],     true); offset += 4
      view.setFloat32(offset, v[c + 1], true); offset += 4
      view.setFloat32(offset, v[c + 2], true); offset += 4
      view.setUint16(offset, 0, true); offset += 2
    }
  }

  return new Uint8Array(buf)
}
