import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { isWebGLAvailable } from '../lib/webgl'

interface Props {
  /** One or more STL files to preview together, laid out on a simple grid —
   *  NOT the engine's real "One plate" arrangement (only orc_slice_multi's
   *  arrange_objects() computes that); this is just enough to see every
   *  loaded model at once instead of only the first. */
  files: File[]
  /** Bed width (X axis) in mm — default 256 */
  bedX?: number
  /** Bed depth (Y axis) in mm — default 256 */
  bedY?: number
  /** Bed shape — 'circle' for delta/round printers, default 'rectangle' */
  bedShape?: 'rectangle' | 'circle'
}

function buildBed(scene: THREE.Scene, bedX: number, bedY: number, bedShape: 'rectangle' | 'circle'): THREE.Object3D[] {
  const disposables: THREE.Object3D[] = []

  if (bedShape === 'circle') {
    const radius = Math.min(bedX, bedY) / 2

    // CircleGeometry is in XY plane by default — correct for Z-up
    const bedGeo = new THREE.CircleGeometry(radius, 64)
    const bedMat = new THREE.MeshPhongMaterial({ color: 0xe2e8f0, side: THREE.DoubleSide })
    const bed = new THREE.Mesh(bedGeo, bedMat)
    bed.receiveShadow = true
    scene.add(bed)
    disposables.push(bed)

    const gridDiv = Math.max(4, Math.round((radius * 2) / 10))
    const grid = new THREE.GridHelper(radius * 2, gridDiv, 0xcccccc, 0xdde3ed)
    grid.rotateX(Math.PI / 2) // rotate from XZ plane to XY plane (Z-up floor)
    grid.position.z = 0.1
    scene.add(grid)
    disposables.push(grid)

    // Circle border in XY plane (Z-up)
    const points: THREE.Vector3[] = []
    const segs = 64
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2
      points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0.2))
    }
    const borderGeo = new THREE.BufferGeometry().setFromPoints(points)
    const borderMat = new THREE.LineBasicMaterial({ color: 0xb0bec5 })
    const border = new THREE.Line(borderGeo, borderMat)
    scene.add(border)
    disposables.push(border)
  } else {
    // PlaneGeometry is in XY plane by default — correct for Z-up
    const bedGeo = new THREE.PlaneGeometry(bedX, bedY)
    const bedMat = new THREE.MeshPhongMaterial({ color: 0xe2e8f0, side: THREE.DoubleSide })
    const bed = new THREE.Mesh(bedGeo, bedMat)
    bed.receiveShadow = true
    scene.add(bed)
    disposables.push(bed)

    const gridDiv = Math.round(Math.max(bedX, bedY) / 10)
    const grid = new THREE.GridHelper(Math.max(bedX, bedY), gridDiv, 0xcccccc, 0xdde3ed)
    grid.scale.set(bedX / Math.max(bedX, bedY), 1, bedY / Math.max(bedX, bedY))
    grid.rotateX(Math.PI / 2) // rotate from XZ plane to XY plane (Z-up floor)
    grid.position.z = 0.1
    scene.add(grid)
    disposables.push(grid)

    const innerBoxGeo = new THREE.BoxGeometry(bedX, bedY, 0.5)
    const edgeGeo = new THREE.EdgesGeometry(innerBoxGeo)
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xb0bec5 })
    const border = new THREE.LineSegments(edgeGeo, edgeMat)
    scene.add(border)
    disposables.push(border)
  }

  return disposables
}

/**
 * Upper bound on how many models the preview will parse and draw at once.
 * Every file here is decoded by STLLoader on the main thread, so an unbounded
 * queue of large STLs would lock up the UI just to render a thumbnail-grade
 * preview; beyond a dozen or so objects the grid isn't legible anyway. The
 * excess is reported through the notice banner rather than dropped silently.
 */
const MAX_PREVIEW_MODELS = 12

export function ModelViewer({ files, bedX = 256, bedY = 256, bedShape = 'rectangle' }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  // Blocking: nothing could be drawn, so the overlay covering the canvas is
  // the whole content. Distinct from `notice` below, which annotates a
  // preview that did render and so must not hide it.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    if (!isWebGLAvailable()) {
      setLoadError('3D preview unavailable in this browser')
      return
    }
    setLoadError(null)
    setNotice(null)

    const w = el.clientWidth
    const h = el.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf8fafc)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000)
    camera.up.set(0, 0, 1) // Z-up to match engine coordinate system

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(100, 100, 200) // Z-up: light comes from above (high Z)
    dirLight.castShadow = true
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0x8ab4f8, 0.3)
    fillLight.position.set(-100, -100, -50)
    scene.add(fillLight)

    const bedObjects = buildBed(scene, bedX, bedY, bedShape)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 10
    controls.maxDistance = 5000
    controls.target.set(0, 0, 0)

    const loader = new STLLoader()
    const meshes: THREE.Mesh[] = []
    const material = new THREE.MeshPhongMaterial({
      color: 0x0a84ff,
      specular: 0x222222,
      shininess: 30,
      side: THREE.DoubleSide,
    })
    let cancelled = false

    const shown = files.slice(0, MAX_PREVIEW_MODELS)
    const skippedCount = files.length - shown.length

    void Promise.all(
      shown.map(async (file) => {
        try {
          const buffer = await file.arrayBuffer()
          const geometry = loader.parse(buffer)
          geometry.computeBoundingBox()
          const box = geometry.boundingBox
          if (!box) return null
          return { geometry, box }
        } catch {
          return null
        }
      }),
    ).then((results) => {
      const loaded = results.filter((r): r is { geometry: THREE.BufferGeometry; box: THREE.Box3 } => r !== null)
      if (cancelled) {
        // Unmounted (or the file set changed) while these were decoding —
        // none of them ever reached the scene, so nothing else will free them.
        for (const { geometry } of loaded) geometry.dispose()
        return
      }
      const failedCount = results.length - loaded.length
      if (loaded.length === 0) {
        setLoadError(failedCount > 0 ? 'Could not read this model file' : null)
        return
      }
      // Everything below this point renders, so any complaint has to be a
      // non-blocking notice — an overlay here would hide the models that did
      // load behind a message about the ones that didn't.
      const notices = [
        failedCount > 0 ? `${failedCount} of ${results.length} files could not be read` : null,
        skippedCount > 0 ? `showing the first ${shown.length} of ${files.length} models` : null,
      ].filter((n): n is string => n !== null)
      if (notices.length > 0) setNotice(notices.join(' · '))

      // Naive preview grid, not the engine's real "One plate" arrangement:
      // equal-sized cells sized to the largest loaded object's footprint
      // plus a fixed gap, filled row-major and centred on the bed origin.
      const sizes = loaded.map(({ box }) => box.getSize(new THREE.Vector3()))
      const gap = 10
      const cellX = Math.max(...sizes.map((s) => s.x)) + gap
      const cellY = Math.max(...sizes.map((s) => s.y)) + gap
      const cols = Math.ceil(Math.sqrt(loaded.length))
      const gridW = cols * cellX
      const gridH = Math.ceil(loaded.length / cols) * cellY

      let maxZ = 0
      loaded.forEach(({ geometry, box }, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        const cellCenterX = -gridW / 2 + cellX * (col + 0.5)
        const cellCenterY = gridH / 2 - cellY * (row + 0.5)

        const center = box.getCenter(new THREE.Vector3())
        // Centre this object within its cell; bottom at Z=0 (engine: X/Y flat, Z = height)
        geometry.translate(cellCenterX - center.x, cellCenterY - center.y, -box.min.z)

        const mesh = new THREE.Mesh(geometry, material)
        mesh.castShadow = true
        scene.add(mesh)
        meshes.push(mesh)
        maxZ = Math.max(maxZ, box.max.z - box.min.z)
      })

      // Fit camera to the whole grid — Z-up: position camera above and to the side
      const maxDim = Math.max(gridW, gridH, maxZ, 50)
      const dist = maxDim * 2
      camera.position.set(dist * 0.6, -dist, dist * 0.7)
      controls.target.set(0, 0, maxZ / 2)
      controls.update()
    })

    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const resizeObs = new ResizeObserver(() => {
      const nw = el.clientWidth
      const nh = el.clientHeight
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
    })
    resizeObs.observe(el)

    return () => {
      cancelled = true
      cancelAnimationFrame(animId)
      resizeObs.disconnect()
      controls.dispose()
      renderer.dispose()
      for (const mesh of meshes) mesh.geometry.dispose()
      material.dispose()
      for (const obj of bedObjects) {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose()
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => {
              m.dispose()
            })
          } else {
            ;(obj.material as THREE.Material).dispose()
          }
        }
      }
      el.removeChild(renderer.domElement)
    }
  }, [files, bedX, bedY, bedShape])

  return (
    <div className="relative w-full h-full min-h-48">
      <div ref={mountRef} className="w-full h-full rounded-xl overflow-hidden" style={{ touchAction: 'none' }} />
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/80 text-sm text-slate-500">
          {loadError}
        </div>
      )}
      {!loadError && notice && (
        <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-amber-50/90 border-t border-amber-200 text-xs text-amber-700 text-center">
          {notice}
        </div>
      )}
    </div>
  )
}
