import { useEffect, useRef, useState, useMemo } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface Props {
  gcode: string
  bedSize?: number
}

interface Layer {
  z: number
  lines: Float32Array // flat [x1,y1,z1, x2,y2,z2, ...]
}

interface ParseResult {
  layers: Layer[]
  /** Centroid of all toolpath points in gcode XY space */
  centerX: number
  centerY: number
}

// Parse G-code into layers of line segments.
// Coordinates are centered at origin (like ModelViewer) so both panels align.
// G-code: X/Y = bed plane, Z = height
// Three.js mapping: gcodeX→x, gcodeZ→y, gcodeY→z  (Z-up → Y-up)
function parseGcode(gcode: string): ParseResult {
  const layerMap = new Map<number, number[]>()
  let cx = 0, cy = 0, cz = 0
  let relative = false
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity

  // First pass: collect raw coordinates
  const rawSegments: { z: number; x1: number; y1: number; x2: number; y2: number }[] = []

  for (const rawLine of gcode.split('\n')) {
    const line = rawLine.split(';')[0].trim()
    if (!line) continue
    const cmd = line.split(/\s+/)
    const g = cmd[0].toUpperCase()
    if (g === 'G91') { relative = true; continue }
    if (g === 'G90') { relative = false; continue }
    if (g === 'G0' || g === 'G1') {
      let nx = cx, ny = cy, nz = cz
      let hasMove = false
      let hasE = false
      for (let i = 1; i < cmd.length; i++) {
        const c = cmd[i][0]?.toUpperCase()
        const v = parseFloat(cmd[i].slice(1))
        if (isNaN(v)) continue
        if (c === 'X') { nx = relative ? cx + v : v; hasMove = true }
        else if (c === 'Y') { ny = relative ? cy + v : v; hasMove = true }
        else if (c === 'Z') { nz = relative ? cz + v : v }
        else if (c === 'E') { hasE = true }
      }
      if (hasMove && g === 'G1' && hasE && cz === nz) {
        rawSegments.push({ z: cz, x1: cx, y1: cy, x2: nx, y2: ny })
        minX = Math.min(minX, cx, nx); maxX = Math.max(maxX, cx, nx)
        minY = Math.min(minY, cy, ny); maxY = Math.max(maxY, cy, ny)
      }
      cx = nx; cy = ny; cz = nz
    }
  }

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  // Second pass: build centered layers
  for (const seg of rawSegments) {
    const zKey = Math.round(seg.z * 1000) / 1000
    if (!layerMap.has(zKey)) layerMap.set(zKey, [])
    // Centered: subtract centroid; gcode X→x, gcode Y→z, gcode Z→y
    layerMap.get(zKey)!.push(
      seg.x1 - centerX, seg.z, seg.y1 - centerY,
      seg.x2 - centerX, seg.z, seg.y2 - centerY,
    )
  }

  const layers = Array.from(layerMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([z, pts]) => ({ z, lines: new Float32Array(pts) }))

  return { layers, centerX, centerY }
}

const LAYER_COLORS = [
  0x0a84ff, 0x30d158, 0xff9f0a, 0xff375f,
  0xbf5af2, 0x64d2ff, 0xffd60a, 0xff6961,
]

export function GcodeViewer({ gcode, bedSize = 250 }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [totalLayers, setTotalLayers] = useState(0)
  const [visibleLayers, setVisibleLayers] = useState(0)

  const { layers } = useMemo(() => parseGcode(gcode), [gcode])

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
    const bedGeo = new THREE.PlaneGeometry(bedSize, bedSize)
    bedGeo.rotateX(-Math.PI / 2)
    const bed = new THREE.Mesh(bedGeo, new THREE.MeshBasicMaterial({ color: 0x1e293b }))
    scene.add(bed)
    const grid = new THREE.GridHelper(bedSize, bedSize / 10, 0x334155, 0x1e293b)
    grid.position.y = 0.15
    scene.add(grid)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    // Build line objects per layer, add all; visibility controlled via visibleLayers
    const lineObjects: THREE.LineSegments[] = []

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      if (layer.lines.length < 6) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(layer.lines, 3))
      const color = LAYER_COLORS[i % LAYER_COLORS.length]
      const mat = new THREE.LineBasicMaterial({ color, linewidth: 1 })
      const segs = new THREE.LineSegments(geo, mat)
      scene.add(segs)
      lineObjects.push(segs)
    }

    // Fit camera to actual toolpath bounds (all centered at origin)
    const allPts = layers.flatMap(l => Array.from(l.lines))
    let maxR = 10
    for (let i = 0; i < allPts.length; i += 3) {
      const r = Math.sqrt(allPts[i] ** 2 + allPts[i + 2] ** 2)
      if (r > maxR) maxR = r
    }
    const maxZ = layers[layers.length - 1]?.z ?? 20
    const dist = Math.max(maxR * 2, maxZ) * 2.5
    camera.position.set(dist * 0.5, dist * 0.6, dist)
    controls.target.set(0, maxZ / 2, 0)
    controls.update()

    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const resizeObs = new ResizeObserver(() => {
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(el.clientWidth, el.clientHeight)
    })
    resizeObs.observe(el)

    // Expose lineObjects for the slider via a ref stored on the element
    ;(el as any).__lineObjects = lineObjects

    return () => {
      cancelAnimationFrame(animId)
      resizeObs.disconnect()
      controls.dispose()
      renderer.dispose()
      lineObjects.forEach(l => { l.geometry.dispose(); (l.material as THREE.Material).dispose() })
      bedGeo.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [layers, bedSize])

  // Update layer visibility when slider changes
  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    const lineObjects: THREE.LineSegments[] | undefined = (el as any).__lineObjects
    if (!lineObjects) return
    lineObjects.forEach((l, i) => { l.visible = i < visibleLayers })
  }, [visibleLayers])

  if (layers.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
        No toolpaths found
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div ref={mountRef} className="flex-1 min-h-0" style={{ touchAction: 'none' }} />
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
      </div>
    </div>
  )
}
