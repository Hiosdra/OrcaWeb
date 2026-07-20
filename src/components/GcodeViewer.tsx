import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { isWebGLAvailable } from '../lib/webgl'

interface Props {
  gcode: string
  bedX?: number
  bedY?: number
  bedShape?: 'rectangle' | 'circle'
}

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

const FEATURE_COLORS: Record<string, number> = {
  'Outer wall': 0xff6b2d,
  'Inner wall': 0x38bdf8,
  'Sparse infill': 0x4ade80,
  'Internal solid infill': 0x818cf8,
  'Top surface': 0xf472b6,
  'Bottom surface': 0xc084fc,
  Support: 0x64748b,
  'Support interface': 0x94a3b8,
  'Bridge infill': 0xfbbf24,
  'Overhang wall': 0xfb923c,
  'Prime tower': 0xe2e8f0,
  'Skirt/Brim': 0x2dd4bf,
  // Bambu-flavor names for the same features
  Skirt: 0x2dd4bf,
  Brim: 0x2dd4bf,
  Custom: 0x94a3b8,
}
const FEATURE_COLOR_DEFAULT = 0x6366f1

function layerGradientColor(t: number): number {
  return new THREE.Color().setHSL((210 - t * 180) / 360, 0.85, 0.55).getHex()
}

/**
 * Tessellate a G2/G3 arc into straight waypoints (flat x,y,z triples,
 * excluding the start point, ending exactly on the target). Supports both
 * I/J (center offset) and R (radius) forms; the R-form center math follows
 * GRBL's plan_arc so the ≤180°/>180° and CW/CCW sign conventions match what
 * firmwares do. Z is interpolated linearly along the sweep (helical moves).
 */
function tessellateArc(
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
      if (!ld.features.has(ft)) ld.features.set(ft, [])
      ld.features.get(ft)!.push(x0, y0, z0, x1, y1, z1)
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

interface SceneObjects {
  extrusion: LineSegments2 | null
  travel: THREE.LineSegments | null
  extrusionEnds: number[]
  travelEnds: number[]
  lineMat: LineMaterial
  layerPlane: THREE.Mesh
}

export function GcodeViewer({ gcode, bedX = 256, bedY = 256, bedShape = 'rectangle' }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneObjects | null>(null)
  const parserWorkerRef = useRef<Worker | null>(null)
  const parserCacheRef = useRef<{ gcode: string; result: ParseResult } | null>(null)
  const parseRequestRef = useRef(0)
  const parsingGcodeRef = useRef('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [visibleLayers, setVisibleLayers] = useState(0)
  const [showTravels, setShowTravels] = useState(false)

  useEffect(() => {
    const worker = new Worker(new URL('../workers/gcode-parser.worker.ts', import.meta.url), { type: 'module' })
    parserWorkerRef.current = worker
    worker.onmessage = ({ data }: MessageEvent<{ id: number; result: ParseResult }>) => {
      if (data.id !== parseRequestRef.current) return
      parserCacheRef.current = { gcode: parsingGcodeRef.current, result: data.result }
      setParsed(data.result)
    }
    return () => worker.terminate()
  }, [])

  useEffect(() => {
    const id = ++parseRequestRef.current
    if (parserCacheRef.current?.gcode === gcode) {
      setParsed(parserCacheRef.current.result)
      return
    }
    setParsed(null)
    parsingGcodeRef.current = gcode
    parserWorkerRef.current?.postMessage({ id, gcode })
  }, [gcode])

  const layers = parsed?.layers ?? []
  const hasFeatureTypes = parsed?.hasFeatureTypes ?? false
  const maxR = parsed?.maxR ?? 10

  useEffect(() => {
    setVisibleLayers(layers.length)
  }, [layers])

  useEffect(() => {
    const el = mountRef.current
    if (!el || layers.length === 0 || !isWebGLAvailable()) return

    const w = el.clientWidth
    const h = el.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0f172a)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000)
    camera.up.set(0, 0, 1) // Z-up to match engine coordinate system
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    el.appendChild(renderer.domElement)

    // Bed — collect grid/border helpers so their geometries & materials can be disposed
    let bedGeo: THREE.PlaneGeometry | THREE.CircleGeometry
    let layerPlaneGeo: THREE.PlaneGeometry | THREE.CircleGeometry
    const bedMat = new THREE.MeshBasicMaterial({ color: 0x1e293b })
    const bedExtras: THREE.Object3D[] = []
    if (bedShape === 'circle') {
      const radius = Math.min(bedX, bedY) / 2
      // CircleGeometry is in XY plane by default — correct for Z-up
      bedGeo = new THREE.CircleGeometry(radius, 64)
      scene.add(new THREE.Mesh(bedGeo, bedMat))
      const gridDiv = Math.max(4, Math.round((radius * 2) / 10))
      const grid = new THREE.GridHelper(radius * 2, gridDiv, 0x334155, 0x1e293b)
      grid.rotateX(Math.PI / 2) // rotate from XZ plane to XY plane (Z-up floor)
      grid.position.z = 0.15
      scene.add(grid)
      bedExtras.push(grid)
      const borderPts: THREE.Vector3[] = []
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2
        borderPts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0.2))
      }
      const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts)
      const borderMat = new THREE.LineBasicMaterial({ color: 0x334155 })
      const border = new THREE.Line(borderGeo, borderMat)
      scene.add(border)
      bedExtras.push(border)
      layerPlaneGeo = new THREE.CircleGeometry(radius * 0.96, 64)
    } else {
      // PlaneGeometry is in XY plane by default — correct for Z-up
      bedGeo = new THREE.PlaneGeometry(bedX, bedY)
      scene.add(new THREE.Mesh(bedGeo, bedMat))
      const gridDiv = Math.round(Math.max(bedX, bedY) / 10)
      const grid = new THREE.GridHelper(Math.max(bedX, bedY), gridDiv, 0x334155, 0x1e293b)
      grid.scale.set(bedX / Math.max(bedX, bedY), 1, bedY / Math.max(bedX, bedY))
      grid.rotateX(Math.PI / 2) // rotate from XZ plane to XY plane (Z-up floor)
      grid.position.z = 0.15
      scene.add(grid)
      bedExtras.push(grid)
      layerPlaneGeo = new THREE.PlaneGeometry(bedX * 0.92, bedY * 0.92)
    }
    // PlaneGeometry/CircleGeometry are already in XY plane — no rotation needed for Z-up

    // Layer cursor plane — semi-transparent plane tracking the current layer height
    const layerPlaneMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    })
    const layerPlane = new THREE.Mesh(layerPlaneGeo, layerPlaneMat)
    scene.add(layerPlane)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    // Single shared material — all layers use vertex colors, same linewidth
    const lineMat = new LineMaterial({
      linewidth: 1.6,
      worldUnits: false,
      vertexColors: true,
      resolution: new THREE.Vector2(w, h),
    })

    const positions: number[] = []
    const colors: number[] = []
    const travels: number[] = []
    const extrusionEnds: number[] = []
    const travelEnds: number[] = []

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]
      const t = layers.length > 1 ? li / (layers.length - 1) : 0

      for (const feature of layer.features) {
        if (feature.segments.length < 6) continue
        const hex = hasFeatureTypes ? (FEATURE_COLORS[feature.type] ?? FEATURE_COLOR_DEFAULT) : layerGradientColor(t)
        const col = new THREE.Color(hex)

        // Each segment = 6 floats (2 vertices × 3 coords); colors match vertex-by-vertex
        for (let i = 0; i < feature.segments.length; i += 3) {
          positions.push(feature.segments[i], feature.segments[i + 1], feature.segments[i + 2])
          colors.push(col.r, col.g, col.b)
        }
      }
      for (let i = 0; i < layer.travels.length; i++) travels.push(layer.travels[i])
      extrusionEnds.push(positions.length / 6)
      travelEnds.push(travels.length / 3)
    }

    let extrusion: LineSegments2 | null = null
    if (positions.length >= 6) {
      const geometry = new LineSegmentsGeometry()
      geometry.setPositions(new Float32Array(positions))
      geometry.setColors(new Float32Array(colors))
      extrusion = new LineSegments2(geometry, lineMat)
      scene.add(extrusion)
    }
    let travel: THREE.LineSegments | null = null
    if (travels.length >= 6) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(travels), 3))
      geometry.setDrawRange(0, 0)
      travel = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.3 }),
      )
      travel.visible = false
      scene.add(travel)
    }

    // Camera fit — Z-up: position camera above and to the side
    const maxZ = layers[layers.length - 1]?.z ?? 20
    const dist = Math.max(maxR * 2, maxZ) * 2.5
    camera.position.set(dist * 0.6, -dist, dist * 0.7)
    controls.target.set(0, 0, maxZ / 2)
    controls.update()

    sceneRef.current = { extrusion, travel, extrusionEnds, travelEnds, lineMat, layerPlane }

    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const resizeObs = new ResizeObserver(() => {
      const rw = el.clientWidth,
        rh = el.clientHeight
      camera.aspect = rw / rh
      camera.updateProjectionMatrix()
      renderer.setSize(rw, rh)
      lineMat.resolution.set(rw, rh)
    })
    resizeObs.observe(el)

    return () => {
      cancelAnimationFrame(animId)
      resizeObs.disconnect()
      controls.dispose()
      renderer.dispose()
      sceneRef.current = null
      lineMat.dispose()
      extrusion?.geometry.dispose()
      travel?.geometry.dispose()
      ;(travel?.material as THREE.Material | undefined)?.dispose()
      bedGeo.dispose()
      bedMat.dispose()
      layerPlaneGeo.dispose()
      layerPlaneMat.dispose()
      for (const obj of bedExtras) {
        if (obj instanceof THREE.Line || obj instanceof THREE.LineSegments || obj instanceof THREE.GridHelper) {
          obj.geometry.dispose()
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => {
              m.dispose()
            })
          } else (obj.material as THREE.Material).dispose()
        }
      }
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [layers, bedX, bedY, bedShape, hasFeatureTypes])

  // Sync layer visibility, travel toggle, and layer cursor position
  useEffect(() => {
    const sc = sceneRef.current
    if (!sc) return
    if (sc.extrusion) sc.extrusion.geometry.instanceCount = sc.extrusionEnds[visibleLayers - 1] ?? 0
    if (sc.travel) {
      sc.travel.geometry.setDrawRange(0, showTravels ? (sc.travelEnds[visibleLayers - 1] ?? 0) : 0)
      sc.travel.visible = showTravels
    }
    const currentZ = layers[visibleLayers - 1]?.z ?? 0
    sc.layerPlane.position.z = currentZ + 0.3
  }, [visibleLayers, showTravels, layers])

  // Feature legend (only when GCode has TYPE comments)
  const featureLegend = useMemo(() => {
    if (!hasFeatureTypes) return []
    const seen = new Map<string, number>()
    for (const layer of layers) {
      for (const f of layer.features) {
        if (!seen.has(f.type)) seen.set(f.type, FEATURE_COLORS[f.type] ?? FEATURE_COLOR_DEFAULT)
      }
    }
    return Array.from(seen.entries())
  }, [layers, hasFeatureTypes])

  if (!parsed) {
    return <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">Parsing preview…</div>
  }

  if (layers.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">No toolpaths found</div>
    )
  }

  if (!isWebGLAvailable()) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
        3D preview unavailable in this browser
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col relative">
      <div ref={mountRef} className="flex-1 min-h-0" style={{ touchAction: 'none' }} />

      {featureLegend.length > 0 && (
        <div className="absolute top-2 right-2 bg-slate-900/85 backdrop-blur-sm rounded-lg px-3 py-2 text-xs space-y-1 max-h-52 overflow-y-auto">
          {featureLegend.map(([type, color]) => (
            <div key={type} className="flex items-center gap-2">
              <div
                className="w-3 h-2 rounded-sm shrink-0"
                style={{ backgroundColor: `#${color.toString(16).padStart(6, '0')}` }}
              />
              <span className="text-slate-300 whitespace-nowrap">{type}</span>
            </div>
          ))}
        </div>
      )}

      <div className="bg-slate-900 px-4 py-2 flex items-center gap-3">
        <span className="text-xs text-slate-400 shrink-0">Layer</span>
        <input
          type="range"
          min={1}
          max={layers.length}
          value={Math.max(1, visibleLayers)}
          onChange={(e) => setVisibleLayers(Number(e.target.value))}
          className="flex-1 accent-orca-400"
        />
        <span className="text-xs text-slate-300 font-mono shrink-0 w-20 text-right">
          {visibleLayers}/{layers.length} · z{layers[visibleLayers - 1]?.z.toFixed(2) ?? '?'}mm
        </span>
        <button
          type="button"
          onClick={() => setShowTravels((v) => !v)}
          className={`text-xs px-2 py-0.5 rounded shrink-0 transition-colors border ${
            showTravels
              ? 'border-slate-500 bg-slate-700 text-slate-200'
              : 'border-slate-700 bg-slate-800 text-slate-500'
          }`}
        >
          Travels
        </button>
      </div>
    </div>
  )
}
