import { useEffect, useRef, useState, useMemo } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

interface Props {
  gcode: string
  bedX?: number
  bedY?: number
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
  'Outer wall':            0xff6b2d,
  'Inner wall':            0x38bdf8,
  'Sparse infill':         0x4ade80,
  'Internal solid infill': 0x818cf8,
  'Top surface':           0xf472b6,
  'Bottom surface':        0xc084fc,
  'Support':               0x64748b,
  'Support interface':     0x94a3b8,
  'Bridge infill':         0xfbbf24,
  'Overhang wall':         0xfb923c,
  'Prime tower':           0xe2e8f0,
  'Skirt/Brim':            0x2dd4bf,
}
const FEATURE_COLOR_DEFAULT = 0x6366f1

function layerGradientColor(t: number): number {
  return new THREE.Color().setHSL((210 - t * 180) / 360, 0.85, 0.55).getHex()
}

function parseGcode(gcode: string): ParseResult {
  const layerMap = new Map<number, { features: Map<string, number[]>; travels: number[] }>()
  let cx = 0, cy = 0, cz = 0
  let relative = false
  let currentFeature = ''
  let hasFeatureTypes = false
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity

  for (const rawLine of gcode.split('\n')) {
    const typeMatch = rawLine.match(/^;\s*TYPE:\s*(.+)/i)
    if (typeMatch) {
      currentFeature = typeMatch[1].trim()
      hasFeatureTypes = true
      continue
    }

    const line = rawLine.split(';')[0].trim()
    if (!line) continue
    const cmd = line.split(/\s+/)
    const g = cmd[0].toUpperCase()

    if (g === 'G91') { relative = true; continue }
    if (g === 'G90') { relative = false; continue }

    if (g === 'G0' || g === 'G1') {
      let nx = cx, ny = cy, nz = cz
      let hasXY = false, hasE = false

      for (let i = 1; i < cmd.length; i++) {
        const c = cmd[i][0]?.toUpperCase()
        const v = parseFloat(cmd[i].slice(1))
        if (isNaN(v)) continue
        if (c === 'X') { nx = relative ? cx + v : v; hasXY = true }
        else if (c === 'Y') { ny = relative ? cy + v : v; hasXY = true }
        else if (c === 'Z') { nz = relative ? cz + v : v }
        else if (c === 'E') { hasE = true }
      }

      if (hasXY && cz === nz) {
        const isTravel = g === 'G0' || !hasE
        const zKey = Math.round(cz * 1000) / 1000
        if (!layerMap.has(zKey)) layerMap.set(zKey, { features: new Map(), travels: [] })
        const ld = layerMap.get(zKey)!

        // G-code: X/Y = bed plane, Z = height → Three.js: gcodeX→x, gcodeZ→y, gcodeY→z
        if (isTravel) {
          ld.travels.push(cx, cz, cy, nx, nz, ny)
        } else {
          const ft = currentFeature || 'Extrusion'
          if (!ld.features.has(ft)) ld.features.set(ft, [])
          ld.features.get(ft)!.push(cx, cz, cy, nx, nz, ny)
          minX = Math.min(minX, cx, nx); maxX = Math.max(maxX, cx, nx)
          minY = Math.min(minY, cy, ny); maxY = Math.max(maxY, cy, ny)
        }
      }

      cx = nx; cy = ny; cz = nz
    }
  }

  const centerX = isFinite(minX) ? (minX + maxX) / 2 : 0
  const centerY = isFinite(minY) ? (minY + maxY) / 2 : 0
  const maxR = isFinite(minX)
    ? Math.sqrt(((maxX - minX) / 2) ** 2 + ((maxY - minY) / 2) ** 2)
    : 10

  const layers: Layer[] = Array.from(layerMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([z, data]) => {
      const features: Feature[] = Array.from(data.features.entries()).map(([type, pts]) => {
        const arr = new Float32Array(pts.length)
        for (let i = 0; i < pts.length; i += 3) {
          arr[i] = pts[i] - centerX
          arr[i + 1] = pts[i + 1]
          arr[i + 2] = pts[i + 2] - centerY
        }
        return { type, segments: arr }
      })

      const ta = new Float32Array(data.travels.length)
      for (let i = 0; i < data.travels.length; i += 3) {
        ta[i] = data.travels[i] - centerX
        ta[i + 1] = data.travels[i + 1]
        ta[i + 2] = data.travels[i + 2] - centerY
      }

      return { z, features, travels: ta }
    })

  return { layers, centerX, centerY, hasFeatureTypes, maxR }
}

interface LayerObj {
  extrusion: LineSegments2 | null
  travel: THREE.LineSegments | null
}

interface SceneObjects {
  layerObjs: LayerObj[]
  lineMat: LineMaterial
  layerPlane: THREE.Mesh
}

export function GcodeViewer({ gcode, bedX = 256, bedY = 256 }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneObjects | null>(null)
  const [totalLayers, setTotalLayers] = useState(0)
  const [visibleLayers, setVisibleLayers] = useState(0)
  const [showTravels, setShowTravels] = useState(false)

  const { layers, hasFeatureTypes, maxR } = useMemo(() => parseGcode(gcode), [gcode])

  useEffect(() => {
    setTotalLayers(layers.length)
    setVisibleLayers(layers.length)
  }, [layers])

  useEffect(() => {
    const el = mountRef.current
    if (!el || layers.length === 0) return

    const w = el.clientWidth
    const h = el.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0f172a)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    el.appendChild(renderer.domElement)

    // Bed
    const bedGeo = new THREE.PlaneGeometry(bedX, bedY)
    bedGeo.rotateX(-Math.PI / 2)
    const bed = new THREE.Mesh(bedGeo, new THREE.MeshBasicMaterial({ color: 0x1e293b }))
    scene.add(bed)
    const gridDiv = Math.round(Math.max(bedX, bedY) / 10)
    const grid = new THREE.GridHelper(Math.max(bedX, bedY), gridDiv, 0x334155, 0x1e293b)
    grid.scale.set(bedX / Math.max(bedX, bedY), 1, bedY / Math.max(bedX, bedY))
    grid.position.y = 0.15
    scene.add(grid)

    // Layer cursor plane — semi-transparent plane tracking the current layer height
    const layerPlaneGeo = new THREE.PlaneGeometry(bedX * 0.92, bedY * 0.92)
    layerPlaneGeo.rotateX(-Math.PI / 2)
    const layerPlane = new THREE.Mesh(layerPlaneGeo, new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
    }))
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

    const layerObjs: LayerObj[] = []

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]
      const t = layers.length > 1 ? li / (layers.length - 1) : 0

      // Merge all features for this layer into one geometry with per-vertex colors
      const positions: number[] = []
      const colors: number[] = []

      for (const feature of layer.features) {
        if (feature.segments.length < 6) continue
        const hex = hasFeatureTypes
          ? (FEATURE_COLORS[feature.type] ?? FEATURE_COLOR_DEFAULT)
          : layerGradientColor(t)
        const col = new THREE.Color(hex)

        // Each segment = 6 floats (2 vertices × 3 coords); colors match vertex-by-vertex
        for (let i = 0; i < feature.segments.length; i += 3) {
          positions.push(feature.segments[i], feature.segments[i + 1], feature.segments[i + 2])
          colors.push(col.r, col.g, col.b)
        }
      }

      let extrusion: LineSegments2 | null = null
      if (positions.length >= 6) {
        const geo = new LineSegmentsGeometry()
        geo.setPositions(new Float32Array(positions))
        geo.setColors(new Float32Array(colors))
        extrusion = new LineSegments2(geo, lineMat)
        scene.add(extrusion)
      }

      let travel: THREE.LineSegments | null = null
      if (layer.travels.length >= 6) {
        const tGeo = new THREE.BufferGeometry()
        tGeo.setAttribute('position', new THREE.BufferAttribute(layer.travels, 3))
        const tMat = new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.3 })
        travel = new THREE.LineSegments(tGeo, tMat)
        travel.visible = false
        scene.add(travel)
      }

      layerObjs.push({ extrusion, travel })
    }

    // Camera fit — maxR pre-computed from bounding box during parsing
    const maxZ = layers[layers.length - 1]?.z ?? 20
    const dist = Math.max(maxR * 2, maxZ) * 2.5
    camera.position.set(dist * 0.6, dist * 0.7, dist * 0.9)
    controls.target.set(0, maxZ / 2, 0)
    controls.update()

    sceneRef.current = { layerObjs, lineMat, layerPlane }

    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const resizeObs = new ResizeObserver(() => {
      const rw = el.clientWidth, rh = el.clientHeight
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
      layerObjs.forEach(({ extrusion, travel }) => {
        extrusion?.geometry.dispose()
        travel?.geometry.dispose()
        ;(travel?.material as THREE.Material | undefined)?.dispose()
      })
      bedGeo.dispose()
      layerPlaneGeo.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [layers, bedX, bedY, hasFeatureTypes])

  // Sync layer visibility, travel toggle, and layer cursor position
  useEffect(() => {
    const sc = sceneRef.current
    if (!sc) return
    sc.layerObjs.forEach(({ extrusion, travel }, i) => {
      const vis = i < visibleLayers
      if (extrusion) extrusion.visible = vis
      if (travel) travel.visible = vis && showTravels
    })
    const currentZ = layers[visibleLayers - 1]?.z ?? 0
    sc.layerPlane.position.y = currentZ + 0.3
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

  if (layers.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
        No toolpaths found
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
          max={totalLayers}
          value={visibleLayers}
          onChange={e => setVisibleLayers(Number(e.target.value))}
          className="flex-1 accent-orca-400"
        />
        <span className="text-xs text-slate-300 font-mono shrink-0 w-20 text-right">
          {visibleLayers}/{totalLayers} · z{layers[visibleLayers - 1]?.z.toFixed(2)}mm
        </span>
        <button
          onClick={() => setShowTravels(v => !v)}
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
