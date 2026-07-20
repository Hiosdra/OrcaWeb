import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { isWebGLAvailable } from '../lib/webgl'
import type { ParseResult } from '../lib/gcode-parse'

interface Props {
  gcode: string
  bedX?: number
  bedY?: number
  bedShape?: 'rectangle' | 'circle'
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
    // No point spinning up the parser worker if there's no WebGL to render
    // the result into — this can be a multi-MB file, so skip the CPU/memory
    // cost entirely rather than parsing something that'll never be shown.
    if (!isWebGLAvailable()) return

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
    if (!isWebGLAvailable()) return
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

  if (!isWebGLAvailable()) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
        3D preview unavailable in this browser
      </div>
    )
  }

  if (!parsed) {
    return <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">Parsing preview…</div>
  }

  if (layers.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">No toolpaths found</div>
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
