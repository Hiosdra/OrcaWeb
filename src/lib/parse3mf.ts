/**
 * 3MF file parser.
 *
 * 3MF is a ZIP archive.  Key contents:
 *   3D/3dmodel.model       — mesh geometry (XML, 3MF core spec)
 *   Metadata/*.json        — OrcaSlicer printer / filament / process profiles
 *   Metadata/*.config      — OrcaSlicer slice settings (JSON-compatible)
 *
 * We extract:
 *   1. Binary STL bytes converted from the XML mesh — passed directly to the
 *      WASM slicer as if the user had loaded an STL file.
 *   2. A merged OrcaConfig patch from all recognised profile files — applied
 *      on top of the current settings panel config.
 */

import { unzipSync } from 'fflate'
import type { OrcaConfig } from '../types'
import { parseOrcaProfileJson } from './profiles'

// ── Public result type ────────────────────────────────────────────────────────

export interface Parse3mfResult {
  /** Binary STL representation of all model meshes */
  stlBytes: Uint8Array
  /** Merged OrcaSlicer settings extracted from embedded profile files */
  config: Partial<OrcaConfig>
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function parse3mf(data: ArrayBuffer): Parse3mfResult {
  const files = unzipSync(new Uint8Array(data))

  // Normalise path separators (some tools use backslashes)
  const normalised: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(files)) {
    normalised[k.replace(/\\/g, '/')] = v
  }

  // 1. Find + parse 3D/3dmodel.model
  const modelKey = Object.keys(normalised).find(
    (k) => k.toLowerCase() === '3d/3dmodel.model',
  )
  if (!modelKey) throw new Error('No 3D model found in 3MF archive (missing 3D/3dmodel.model)')

  const xml = new TextDecoder('utf-8').decode(normalised[modelKey])
  const stlBytes = modelXmlToStl(xml)

  // 2. Extract OrcaSlicer profiles from Metadata/
  const config = extractOrcaConfig(normalised)

  return { stlBytes, config }
}

// ── XML → binary STL conversion ───────────────────────────────────────────────

/**
 * Converts a 3MF core `3dmodel.model` XML string to binary STL.
 * Handles multiple `<object>` elements; skips support / non-model types.
 * Applies `<item>` transforms from the `<build>` section.
 */
function modelXmlToStl(xml: string): Uint8Array {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')

  // DOMParser returns a <parsererror> document on malformed XML instead of throwing
  const parseErr = doc.querySelector('parsererror')
  if (parseErr) {
    const msg = parseErr.textContent?.split('\n')[0]?.trim() ?? 'XML parse error'
    throw new Error(`Invalid 3MF XML: ${msg}`)
  }

  // Build a map of object id → {vertices, triangles}
  const objectMap = new Map<
    string,
    { verts: number[][]; tris: [number, number, number][] }
  >()

  for (const obj of Array.from(doc.getElementsByTagName('object'))) {
    const type = obj.getAttribute('type') ?? 'model'
    if (type === 'support' || type === 'other') continue

    const id = obj.getAttribute('id') ?? ''
    const verts: number[][] = []
    const tris: [number, number, number][] = []

    for (const v of Array.from(obj.getElementsByTagName('vertex'))) {
      verts.push([
        parseFloat(v.getAttribute('x') ?? '0'),
        parseFloat(v.getAttribute('y') ?? '0'),
        parseFloat(v.getAttribute('z') ?? '0'),
      ])
    }
    for (const t of Array.from(obj.getElementsByTagName('triangle'))) {
      tris.push([
        parseInt(t.getAttribute('v1') ?? '0', 10),
        parseInt(t.getAttribute('v2') ?? '0', 10),
        parseInt(t.getAttribute('v3') ?? '0', 10),
      ])
    }

    if (verts.length > 0 && tris.length > 0) objectMap.set(id, { verts, tris })
  }

  // Collect all triangles from build items, applying transforms
  const allTriangles: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ][] = []

  for (const item of Array.from(doc.getElementsByTagName('item'))) {
    const oid = item.getAttribute('objectid') ?? ''
    const obj = objectMap.get(oid)
    if (!obj) continue

    const transformStr = item.getAttribute('transform')
    const m = transformStr ? parseTransform(transformStr) : null

    for (const [i1, i2, i3] of obj.tris) {
      const p1 = transformPoint(obj.verts[i1] ?? [0, 0, 0], m)
      const p2 = transformPoint(obj.verts[i2] ?? [0, 0, 0], m)
      const p3 = transformPoint(obj.verts[i3] ?? [0, 0, 0], m)
      if (p1 && p2 && p3) allTriangles.push([p1, p2, p3])
    }
  }

  // Fall back: if build section was empty, include all model objects as-is
  if (allTriangles.length === 0) {
    for (const obj of objectMap.values()) {
      for (const [i1, i2, i3] of obj.tris) {
        const p1 = obj.verts[i1], p2 = obj.verts[i2], p3 = obj.verts[i3]
        if (p1 && p2 && p3) {
          allTriangles.push([p1 as [number,number,number], p2 as [number,number,number], p3 as [number,number,number]])
        }
      }
    }
  }

  if (allTriangles.length === 0) throw new Error('3MF model contains no geometry')

  return trianglesToStl(allTriangles)
}

/** Parse a 3MF column-major 3×4 transform string into a 12-element array (or null). */
function parseTransform(s: string): number[] | null {
  const nums = s.trim().split(/\s+/).map(Number)
  return nums.length === 12 ? nums : null
}

/**
 * Apply a 3MF column-major transform matrix to a point.
 * The 3MF spec stores the matrix as three column vectors followed by translation:
 *   m00 m01 m02  m10 m11 m12  m20 m21 m22  tx ty tz
 * So result = col0*x + col1*y + col2*z + t
 */
function transformPoint(
  p: number[],
  m: number[] | null,
): [number, number, number] {
  if (!m) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
  const x = p[0] ?? 0, y = p[1] ?? 0, z = p[2] ?? 0
  return [
    m[0] * x + m[3] * y + m[6] * z + m[9],
    m[1] * x + m[4] * y + m[7] * z + m[10],
    m[2] * x + m[5] * y + m[8] * z + m[11],
  ]
}

type Tri3 = [[number,number,number],[number,number,number],[number,number,number]]

/** Encode a list of triangles as a binary STL Uint8Array. */
function trianglesToStl(tris: Tri3[]): Uint8Array {
  // 80-byte header + 4-byte count + N × 50 bytes
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const dv = new DataView(buf)
  let off = 80
  dv.setUint32(off, tris.length, true)
  off += 4
  for (const [p1, p2, p3] of tris) {
    // Compute face normal via cross product
    const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2]
    const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
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

// ── Profile extraction ────────────────────────────────────────────────────────

/**
 * Scan all files in the Metadata/ directory and try to parse each as an
 * OrcaSlicer profile JSON.  Results are merged in order: printer < filament
 * < process < project (later entries win on conflicts).
 */
function extractOrcaConfig(files: Record<string, Uint8Array>): Partial<OrcaConfig> {
  const merged: Partial<OrcaConfig> = {}

  // Prioritise files by name so that later/more-specific configs override earlier ones.
  // Use lowercased paths throughout so that case variants (metadata/, .JSON, .Config)
  // from different ZIP tools are handled correctly.
  const priority = (p: string): number => {
    const lower = p.toLowerCase()
    if (lower.includes('project')) return 4
    if (lower.includes('process') || lower.includes('print')) return 3
    if (lower.includes('filament')) return 2
    if (lower.includes('machine') || lower.includes('printer')) return 1
    return 0
  }

  const metaPaths = Object.keys(files)
    .filter((k) => {
      const lower = k.toLowerCase()
      return lower.startsWith('metadata/') && (lower.endsWith('.json') || lower.endsWith('.config'))
    })
    .sort((a, b) => priority(a) - priority(b))

  for (const path of metaPaths) {
    try {
      const text = new TextDecoder('utf-8').decode(files[path])
      const patch = parseOrcaProfileJson(text)
      if (Object.keys(patch).length > 0) Object.assign(merged, patch)
    } catch {
      // Skip malformed files silently
    }
  }

  return merged
}
