import initOcctImport from 'occt-import-js'
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OcctInstance = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _occt: Promise<any> | null = null

function getOcct(): Promise<OcctInstance> {
  if (!_occt) {
    _occt = initOcctImport({ locateFile: () => occtWasmUrl }).catch((err: unknown) => {
      _occt = null // allow retry on next call
      throw err
    })
  }
  return _occt
}

export async function cadToStl(filename: string, buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const occt = await getOcct()
  const data = new Uint8Array(buffer)

  const isIges = /\.(iges|igs)$/i.test(filename)
  const result: { success: boolean; meshes?: OcctInstance[] } = isIges
    ? occt.ReadIgesFile(data, null)
    : occt.ReadStepFile(data, null)

  if (!result.success || !result.meshes || result.meshes.length === 0) {
    throw new Error(`Failed to parse ${isIges ? 'IGES' : 'STEP'} file`)
  }

  return meshesToBinaryStl(result.meshes)
}

// occt-import-js mesh shape:
//   mesh.attributes.position.array — flat vertex coords (x,y,z triplets)
//   mesh.index.array               — flat triangle indices (3 per triangle)
function meshesToBinaryStl(meshes: OcctInstance[]): Uint8Array<ArrayBuffer> {
  type ValidMesh = { pos: ArrayLike<number>; idx: ArrayLike<number> }
  const valid: ValidMesh[] = []
  let totalTriangles = 0

  for (const mesh of meshes) {
    const pos: ArrayLike<number> | undefined = mesh?.attributes?.position?.array
    const idx: ArrayLike<number> | undefined = mesh?.index?.array
    if (!pos || !idx) continue
    valid.push({ pos, idx })
    totalTriangles += Math.floor(idx.length / 3)
  }

  // Binary STL: 80-byte header + 4-byte count + 50 bytes per triangle
  const buf = new ArrayBuffer(84 + totalTriangles * 50)
  const view = new DataView(buf)
  view.setUint32(80, totalTriangles, true)

  let offset = 84
  for (const { pos, idx } of valid) {
    const triCount = Math.floor(idx.length / 3)
    for (let i = 0; i < triCount * 3; i += 3) {
      const a = idx[i] * 3
      const b = idx[i + 1] * 3
      const c = idx[i + 2] * 3

      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
      const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2]
      const nx = uy * wz - uz * wy
      const ny = uz * wx - ux * wz
      const nz = ux * wy - uy * wx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1

      view.setFloat32(offset, nx / len, true); offset += 4
      view.setFloat32(offset, ny / len, true); offset += 4
      view.setFloat32(offset, nz / len, true); offset += 4
      view.setFloat32(offset, pos[a],     true); offset += 4
      view.setFloat32(offset, pos[a + 1], true); offset += 4
      view.setFloat32(offset, pos[a + 2], true); offset += 4
      view.setFloat32(offset, pos[b],     true); offset += 4
      view.setFloat32(offset, pos[b + 1], true); offset += 4
      view.setFloat32(offset, pos[b + 2], true); offset += 4
      view.setFloat32(offset, pos[c],     true); offset += 4
      view.setFloat32(offset, pos[c + 1], true); offset += 4
      view.setFloat32(offset, pos[c + 2], true); offset += 4
      view.setUint16(offset, 0, true); offset += 2
    }
  }

  return new Uint8Array(buf)
}
