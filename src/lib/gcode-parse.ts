// Shared G-code toolpath parser — used by both the GcodeViewer component
// (main thread, in tests) and gcode-parser.worker.ts (off-main-thread
// rendering). A single source of truth so the two never drift apart again —
// a duplicated copy previously reverted to E-presence extrusion
// classification and lost G92/M82/M83 handling (see PR #130/#132 history).

export interface Feature {
  type: string
  segments: Float32Array
}

export interface Layer {
  z: number
  features: Feature[]
  travels: Float32Array
}

export interface ParseResult {
  layers: Layer[]
  centerX: number
  centerY: number
  hasFeatureTypes: boolean
  maxR: number
}

/**
 * Tessellate a G2/G3 arc into straight waypoints (flat x,y,z triples,
 * excluding the start point, ending exactly on the target). Supports both
 * I/J (center offset) and R (radius) forms; the R-form center math follows
 * GRBL's plan_arc so the ≤180°/>180° and CW/CCW sign conventions match what
 * firmwares do. Z is interpolated linearly along the sweep (helical moves).
 */
export function tessellateArc(
  sx: number,
  sy: number,
  sz: number,
  ex: number,
  ey: number,
  ez: number,
  i: number | null,
  j: number | null,
  r: number | null,
  clockwise: boolean,
): number[] {
  let ox: number, oy: number // arc center
  if (i !== null || j !== null) {
    ox = sx + (i ?? 0)
    oy = sy + (j ?? 0)
  } else if (r !== null && r !== 0) {
    const dx = ex - sx,
      dy = ey - sy
    const dSq = dx * dx + dy * dy
    const hFactorSq = 4 * r * r - dSq
    if (dSq === 0 || hFactorSq < 0) return [ex, ey, ez] // degenerate — draw a chord
    let hx2divd = -Math.sqrt(hFactorSq) / Math.sqrt(dSq)
    if (!clockwise) hx2divd = -hx2divd
    if (r < 0) hx2divd = -hx2divd
    ox = sx + 0.5 * (dx - dy * hx2divd)
    oy = sy + 0.5 * (dy + dx * hx2divd)
  } else {
    return [ex, ey, ez]
  }

  const radius = Math.hypot(sx - ox, sy - oy)
  if (radius < 1e-9) return [ex, ey, ez]

  const a0 = Math.atan2(sy - oy, sx - ox)
  const a1 = Math.atan2(ey - oy, ex - ox)
  let sweep = a1 - a0
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI
  // Start ≈ end with an explicit center = full circle
  if (Math.abs(sweep) < 1e-9 && Math.hypot(ex - sx, ey - sy) < 1e-9) {
    sweep = clockwise ? -2 * Math.PI : 2 * Math.PI
  }

  // ~0.5 mm chords, clamped so a huge arc can't explode the segment count
  const steps = Math.min(64, Math.max(2, Math.ceil((Math.abs(sweep) * radius) / 0.5)))
  const out: number[] = []
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    const a = a0 + sweep * t
    out.push(ox + radius * Math.cos(a), oy + radius * Math.sin(a), sz + (ez - sz) * t)
  }
  out.push(ex, ey, ez)
  return out
}

export function parseGcode(gcode: string): ParseResult {
  interface LayerAcc {
    z: number
    features: Map<string, number[]>
    travels: number[]
  }

  // OrcaSlicer output delimits layers with ";LAYER_CHANGE" + ";Z:<height>"
  // comments — authoritative even in spiral/vase mode, where Z rises
  // continuously and no two extrusions share a Z value. Third-party G-code
  // without markers falls back to bucketing by each move's starting Z.
  // Probe only the head: the first marker sits right after the header +
  // start G-code (well under 256 KB even with large object-definition
  // preambles), and this avoids a full scan of marker-less multi-MB files.
  const hasLayerMarkers = /^;\s*(LAYER_CHANGE|CHANGE_LAYER)/im.test(gcode.slice(0, 262_144))

  const markerLayers: LayerAcc[] = []
  const layerMap = new Map<number, LayerAcc>()
  let cur: LayerAcc | null = null

  let cx = 0,
    cy = 0,
    cz = 0
  let relative = false
  let extrusionRelative = false
  let ce = 0
  let currentFeature = ''
  let hasFeatureTypes = false
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity

  const layerFor = (startZ: number): LayerAcc => {
    if (hasLayerMarkers) {
      // Anything before the first marker (priming, skirt in start G-code)
      // gets an implicit first layer.
      if (!cur) {
        cur = { z: startZ, features: new Map(), travels: [] }
        markerLayers.push(cur)
      }
      return cur
    }
    const zKey = Math.round(startZ * 1000) / 1000
    let acc = layerMap.get(zKey)
    if (!acc) {
      acc = { z: zKey, features: new Map(), travels: [] }
      layerMap.set(zKey, acc)
    }
    return acc
  }

  const addSegment = (isTravel: boolean, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    // Without layer markers, a Z-changing move has no layer to belong to —
    // binning continuous spiral/z-hop moves by starting Z would fragment the
    // print into thousands of one-segment "layers", so skip them (the
    // pre-marker behaviour). With markers the current layer owns the move.
    if (!hasLayerMarkers && z0 !== z1) return
    // G-code coords match engine: X/Y = bed plane, Z = height — use directly (Z-up scene)
    const ld = layerFor(z0)
    if (isTravel) {
      ld.travels.push(x0, y0, z0, x1, y1, z1)
    } else {
      const ft = currentFeature || 'Extrusion'
      let arr = ld.features.get(ft)
      if (!arr) {
        arr = []
        ld.features.set(ft, arr)
      }
      arr.push(x0, y0, z0, x1, y1, z1)
      minX = Math.min(minX, x0, x1)
      maxX = Math.max(maxX, x0, x1)
      minY = Math.min(minY, y0, y1)
      maxY = Math.max(maxY, y0, y1)
    }
  }

  for (const rawLine of gcode.split('\n')) {
    if (rawLine.charCodeAt(0) === 59 /* ';' */) {
      // The engine emits ";TYPE:<t>" (Marlin/generic flavor) or
      // "; FEATURE: <t>" (Bambu flavor) depending on the printer profile.
      const typeMatch = rawLine.match(/^;\s*(?:TYPE|FEATURE):\s*(.+)/i)
      if (typeMatch) {
        currentFeature = typeMatch[1].trim()
        hasFeatureTypes = true
        continue
      }
      if (hasLayerMarkers) {
        if (/^;\s*(LAYER_CHANGE|CHANGE_LAYER)/i.test(rawLine)) {
          cur = { z: NaN, features: new Map(), travels: [] }
          markerLayers.push(cur)
          continue
        }
        if (cur && Number.isNaN(cur.z)) {
          // ";Z:0.2" (generic) / "; Z_HEIGHT: 0.2" (Bambu)
          const zMatch = rawLine.match(/^;\s*Z(?:_HEIGHT)?:\s*([\d.]+)/i)
          if (zMatch) cur.z = parseFloat(zMatch[1])
        }
      }
      continue
    }

    const line = rawLine.split(';')[0].trim()
    if (!line) continue
    const cmd = line.split(/\s+/)
    const g = cmd[0].toUpperCase()

    if (g === 'G91') {
      relative = true
      continue
    }
    if (g === 'G90') {
      relative = false
      continue
    }
    if (g === 'M83') {
      extrusionRelative = true
      continue
    }
    if (g === 'M82') {
      extrusionRelative = false
      continue
    }
    if (g === 'G92') {
      for (let k = 1; k < cmd.length; k++) {
        const c = cmd[k][0]?.toUpperCase()
        const v = parseFloat(cmd[k].slice(1))
        if (Number.isNaN(v)) continue
        if (c === 'X') cx = v
        else if (c === 'Y') cy = v
        else if (c === 'Z') cz = v
        else if (c === 'E') ce = v
      }
      continue
    }

    const isLinear = g === 'G0' || g === 'G1'
    const isArc = g === 'G2' || g === 'G3'
    if (!isLinear && !isArc) continue

    let nx = cx,
      ny = cy,
      nz = cz
    let hasXY = false,
      hasE = false,
      e = 0
    let ai: number | null = null,
      aj: number | null = null,
      ar: number | null = null

    for (let k = 1; k < cmd.length; k++) {
      const c = cmd[k][0]?.toUpperCase()
      const v = parseFloat(cmd[k].slice(1))
      if (Number.isNaN(v)) continue
      if (c === 'X') {
        nx = relative ? cx + v : v
        hasXY = true
      } else if (c === 'Y') {
        ny = relative ? cy + v : v
        hasXY = true
      } else if (c === 'Z') {
        nz = relative ? cz + v : v
      } else if (c === 'E') {
        e = v
        hasE = true
      } else if (c === 'I')
        ai = v // arc center offsets are always relative to the start point
      else if (c === 'J') aj = v
      else if (c === 'R') ar = v
    }

    const nextE = hasE ? (extrusionRelative ? ce + e : e) : ce
    const extrusionDelta = hasE ? (extrusionRelative ? e : nextE - ce) : 0
    const isTravel = g === 'G0' || extrusionDelta <= 0

    if (isLinear) {
      if (hasXY) addSegment(isTravel, cx, cy, cz, nx, ny, nz)
    } else if (hasXY || ai !== null || aj !== null) {
      const waypoints = tessellateArc(cx, cy, cz, nx, ny, nz, ai, aj, ar, g === 'G2')
      let px = cx,
        py = cy,
        pz = cz
      for (let k = 0; k < waypoints.length; k += 3) {
        addSegment(isTravel, px, py, pz, waypoints[k], waypoints[k + 1], waypoints[k + 2])
        px = waypoints[k]
        py = waypoints[k + 1]
        pz = waypoints[k + 2]
      }
    }

    cx = nx
    cy = ny
    cz = nz
    ce = nextE
  }

  const centerX = Number.isFinite(minX) ? (minX + maxX) / 2 : 0
  const centerY = Number.isFinite(minY) ? (minY + maxY) / 2 : 0
  const maxR = Number.isFinite(minX) ? Math.sqrt(((maxX - minX) / 2) ** 2 + ((maxY - minY) / 2) ** 2) : 10

  const accs = hasLayerMarkers
    ? markerLayers.filter((l) => l.features.size > 0 || l.travels.length > 0)
    : Array.from(layerMap.values()).sort((a, b) => a.z - b.z)

  const layers: Layer[] = accs.map((data) => {
    const features: Feature[] = Array.from(data.features.entries()).map(([type, pts]) => {
      const arr = new Float32Array(pts.length)
      for (let i = 0; i < pts.length; i += 3) {
        arr[i] = pts[i] - centerX // X
        arr[i + 1] = pts[i + 1] - centerY // Y
        arr[i + 2] = pts[i + 2] // Z (height, no centering)
      }
      return { type, segments: arr }
    })

    const ta = new Float32Array(data.travels.length)
    for (let i = 0; i < data.travels.length; i += 3) {
      ta[i] = data.travels[i] - centerX
      ta[i + 1] = data.travels[i + 1] - centerY
      ta[i + 2] = data.travels[i + 2]
    }

    // A marker layer whose ;Z: comment was missing falls back to the Z of
    // its first recorded segment.
    const z = Number.isNaN(data.z) ? (features[0]?.segments[2] ?? ta[2] ?? 0) : data.z
    return { z, features, travels: ta }
  })

  return { layers, centerX, centerY, hasFeatureTypes, maxR }
}
