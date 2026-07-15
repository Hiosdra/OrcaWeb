interface Feature {
  type: string
  segments: Float32Array
}

interface Layer {
  z: number
  features: Feature[]
  travels: Float32Array
}

interface ParseResult {
  layers: Layer[]
  centerX: number
  centerY: number
  hasFeatureTypes: boolean
  maxR: number
}

function tessellateArc(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, i: number | null, j: number | null, r: number | null, clockwise: boolean): number[] {
  let ox: number, oy: number
  if (i !== null || j !== null) { ox = sx + (i ?? 0); oy = sy + (j ?? 0) }
  else if (r !== null && r !== 0) {
    const dx = ex - sx, dy = ey - sy, dSq = dx * dx + dy * dy, hFactorSq = 4 * r * r - dSq
    if (dSq === 0 || hFactorSq < 0) return [ex, ey, ez]
    let hx2divd = -Math.sqrt(hFactorSq) / Math.sqrt(dSq)
    if (!clockwise) hx2divd = -hx2divd
    if (r < 0) hx2divd = -hx2divd
    ox = sx + 0.5 * (dx - dy * hx2divd); oy = sy + 0.5 * (dy + dx * hx2divd)
  } else return [ex, ey, ez]

  const radius = Math.hypot(sx - ox, sy - oy)
  if (radius < 1e-9) return [ex, ey, ez]
  const a0 = Math.atan2(sy - oy, sx - ox), a1 = Math.atan2(ey - oy, ex - ox)
  let sweep = a1 - a0
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI
  if (Math.abs(sweep) < 1e-9 && Math.hypot(ex - sx, ey - sy) < 1e-9) sweep = clockwise ? -2 * Math.PI : 2 * Math.PI
  const steps = Math.min(64, Math.max(2, Math.ceil((Math.abs(sweep) * radius) / 0.5)))
  const out: number[] = []
  for (let step = 1; step < steps; step++) {
    const t = step / steps, a = a0 + sweep * t
    out.push(ox + radius * Math.cos(a), oy + radius * Math.sin(a), sz + (ez - sz) * t)
  }
  out.push(ex, ey, ez)
  return out
}

function parseGcode(gcode: string): ParseResult {
  interface LayerAcc { z: number; features: Map<string, number[]>; travels: number[] }
  const hasLayerMarkers = /^;\s*(LAYER_CHANGE|CHANGE_LAYER)/im.test(gcode.slice(0, 262_144))
  const markerLayers: LayerAcc[] = [], layerMap = new Map<number, LayerAcc>()
  let cur: LayerAcc | null = null
  let cx = 0, cy = 0, cz = 0, relative = false, currentFeature = '', hasFeatureTypes = false
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const layerFor = (startZ: number): LayerAcc => {
    if (hasLayerMarkers) {
      if (!cur) { cur = { z: startZ, features: new Map(), travels: [] }; markerLayers.push(cur) }
      return cur
    }
    const zKey = Math.round(startZ * 1000) / 1000
    let acc = layerMap.get(zKey)
    if (!acc) { acc = { z: zKey, features: new Map(), travels: [] }; layerMap.set(zKey, acc) }
    return acc
  }
  const addSegment = (isTravel: boolean, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    if (!hasLayerMarkers && z0 !== z1) return
    const layer = layerFor(z0)
    if (isTravel) layer.travels.push(x0, y0, z0, x1, y1, z1)
    else {
      const feature = currentFeature || 'Extrusion'
      if (!layer.features.has(feature)) layer.features.set(feature, [])
      layer.features.get(feature)!.push(x0, y0, z0, x1, y1, z1)
      minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1)
      minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1)
    }
  }
  for (const rawLine of gcode.split('\n')) {
    if (rawLine.charCodeAt(0) === 59) {
      const typeMatch = rawLine.match(/^;\s*(?:TYPE|FEATURE):\s*(.+)/i)
      if (typeMatch) { currentFeature = typeMatch[1].trim(); hasFeatureTypes = true; continue }
      if (hasLayerMarkers) {
        if (/^;\s*(LAYER_CHANGE|CHANGE_LAYER)/i.test(rawLine)) { cur = { z: NaN, features: new Map(), travels: [] }; markerLayers.push(cur); continue }
        if (cur && Number.isNaN(cur.z)) {
          const zMatch = rawLine.match(/^;\s*Z(?:_HEIGHT)?:\s*([\d.]+)/i)
          if (zMatch) cur.z = parseFloat(zMatch[1])
        }
      }
      continue
    }
    const line = rawLine.split(';')[0].trim()
    if (!line) continue
    const cmd = line.split(/\s+/), g = cmd[0].toUpperCase()
    if (g === 'G91') { relative = true; continue }
    if (g === 'G90') { relative = false; continue }
    const isLinear = g === 'G0' || g === 'G1', isArc = g === 'G2' || g === 'G3'
    if (!isLinear && !isArc) continue
    let nx = cx, ny = cy, nz = cz, hasXY = false, hasE = false
    let ai: number | null = null, aj: number | null = null, ar: number | null = null
    for (let k = 1; k < cmd.length; k++) {
      const c = cmd[k][0]?.toUpperCase(), v = parseFloat(cmd[k].slice(1))
      if (isNaN(v)) continue
      if (c === 'X') { nx = relative ? cx + v : v; hasXY = true }
      else if (c === 'Y') { ny = relative ? cy + v : v; hasXY = true }
      else if (c === 'Z') nz = relative ? cz + v : v
      else if (c === 'E') hasE = true
      else if (c === 'I') ai = v
      else if (c === 'J') aj = v
      else if (c === 'R') ar = v
    }
    if (isLinear) { if (hasXY) addSegment(g === 'G0' || !hasE, cx, cy, cz, nx, ny, nz) }
    else if (hasXY || ai !== null || aj !== null) {
      const points = tessellateArc(cx, cy, cz, nx, ny, nz, ai, aj, ar, g === 'G2')
      let px = cx, py = cy, pz = cz
      for (let k = 0; k < points.length; k += 3) { addSegment(!hasE, px, py, pz, points[k], points[k + 1], points[k + 2]); px = points[k]; py = points[k + 1]; pz = points[k + 2] }
    }
    cx = nx; cy = ny; cz = nz
  }
  const centerX = isFinite(minX) ? (minX + maxX) / 2 : 0, centerY = isFinite(minY) ? (minY + maxY) / 2 : 0
  const maxR = isFinite(minX) ? Math.hypot((maxX - minX) / 2, (maxY - minY) / 2) : 10
  const accs = hasLayerMarkers ? markerLayers.filter(layer => layer.features.size > 0 || layer.travels.length > 0) : Array.from(layerMap.values()).sort((a, b) => a.z - b.z)
  const layers = accs.map((data): Layer => {
    const features = Array.from(data.features.entries()).map(([type, points]) => {
      const segments = new Float32Array(points.length)
      for (let i = 0; i < points.length; i += 3) { segments[i] = points[i] - centerX; segments[i + 1] = points[i + 1] - centerY; segments[i + 2] = points[i + 2] }
      return { type, segments }
    })
    const travels = new Float32Array(data.travels.length)
    for (let i = 0; i < travels.length; i += 3) { travels[i] = data.travels[i] - centerX; travels[i + 1] = data.travels[i + 1] - centerY; travels[i + 2] = data.travels[i + 2] }
    const z = Number.isNaN(data.z) ? (features[0]?.segments[2] ?? travels[2] ?? 0) : data.z
    return { z, features, travels }
  })
  return { layers, centerX, centerY, hasFeatureTypes, maxR }
}

self.onmessage = ({ data: { id, gcode } }: MessageEvent<{ id: number; gcode: string }>) => {
  const result = parseGcode(gcode)
  const transfers: Transferable[] = []
  for (const layer of result.layers) {
    for (const feature of layer.features) transfers.push(feature.segments.buffer as ArrayBuffer)
    transfers.push(layer.travels.buffer as ArrayBuffer)
  }
  self.postMessage({ id, result }, transfers)
}
