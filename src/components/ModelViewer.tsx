import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { isWebGLAvailable } from '../lib/webgl'
import type { ObjectTransform } from '../types'

export interface ModelPreview {
  id: string
  file: File
  transform?: ObjectTransform
}

interface Props {
  /** One or more STL files to preview together. */
  files: File[]
  /** Optional stable IDs and engine-side transforms for the current plate. */
  models?: ModelPreview[]
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

function applyTransform(mesh: THREE.Mesh, transform: ObjectTransform | undefined): void {
  if (!transform) return
  mesh.scale.set(
    transform.scale[0] * transform.mirror[0],
    transform.scale[1] * transform.mirror[1],
    transform.scale[2] * transform.mirror[2],
  )
  mesh.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2])
}

export function ModelViewer({ files, models, bedX = 256, bedY = 256, bedShape = 'rectangle' }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  // Blocking: nothing could be drawn, so the overlay covering the canvas is
  // the whole content. Distinct from `notice` below, which annotates a
  // preview that did render and so must not hide it.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fileModels = useMemo(() => files.map((file, index) => ({ id: `file-${index}`, file })), [files])
  const previewModels = models ?? fileModels

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

    const shown = previewModels.slice(0, MAX_PREVIEW_MODELS)
    const skippedCount = previewModels.length - shown.length

    void Promise.all(
      shown.map(async (model) => {
        try {
          const buffer = await model.file.arrayBuffer()
          const geometry = loader.parse(buffer)
          geometry.computeBoundingBox()
          const box = geometry.boundingBox
          if (!box) return null
          return { geometry, box, model }
        } catch {
          return null
        }
      }),
    ).then((results) => {
      const loaded = results.filter(
        (r): r is { geometry: THREE.BufferGeometry; box: THREE.Box3; model: ModelPreview } => r !== null,
      )
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
        skippedCount > 0 ? `showing the first ${shown.length} of ${previewModels.length} models` : null,
      ].filter((n): n is string => n !== null)
      if (notices.length > 0) setNotice(notices.join(' · '))

      // Centre every raw mesh like the bridge does before applying the
      // instance transform. Models without an explicit arranged offset still
      // use a small fallback grid so a freshly uploaded plate remains legible.
      const transformed = loaded.map(({ geometry, box, model }) => {
        const center = box.getCenter(new THREE.Vector3())
        geometry.translate(-center.x, -center.y, -box.min.z)
        const mesh = new THREE.Mesh(geometry, material)
        mesh.castShadow = true
        applyTransform(mesh, model.transform)
        mesh.updateMatrixWorld(true)
        const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3())
        return { mesh, model, size }
      })

      const gridItems = transformed.filter(({ model }) => model.transform?.offset == null)
      const gap = 10
      const cellX = (gridItems.length > 0 ? Math.max(...gridItems.map(({ size }) => size.x)) : 0) + gap
      const cellY = (gridItems.length > 0 ? Math.max(...gridItems.map(({ size }) => size.y)) : 0) + gap
      const cols = Math.max(1, Math.ceil(Math.sqrt(gridItems.length)))
      const gridW = cols * cellX
      const gridH = Math.ceil(gridItems.length / cols) * cellY

      let gridIndex = 0
      const sceneBounds = new THREE.Box3()
      transformed.forEach(({ mesh, model }) => {
        if (model.transform?.offset) {
          mesh.position.x = model.transform.offset[0]
          mesh.position.y = model.transform.offset[1]
        } else {
          const col = gridIndex % cols
          const row = Math.floor(gridIndex / cols)
          mesh.position.x = -gridW / 2 + cellX * (col + 0.5)
          mesh.position.y = gridH / 2 - cellY * (row + 0.5)
          gridIndex++
        }
        // Engine ensure_on_bed() is applied after rotation and scaling. Do the
        // same for the visual model so an auto-oriented object never floats or
        // clips through the preview bed.
        mesh.updateMatrixWorld(true)
        const placedBounds = new THREE.Box3().setFromObject(mesh)
        mesh.position.z -= placedBounds.min.z
        mesh.updateMatrixWorld(true)
        scene.add(mesh)
        meshes.push(mesh)
        sceneBounds.union(new THREE.Box3().setFromObject(mesh))
      })

      // Fit camera to the bed and all transformed models — Z-up: position
      // camera above and to the side.
      const maxZ = Math.max(sceneBounds.max.z, 0)
      const maxDim = Math.max(
        bedX,
        bedY,
        sceneBounds.getSize(new THREE.Vector3()).x,
        sceneBounds.getSize(new THREE.Vector3()).y,
        maxZ,
        50,
      )
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
  }, [previewModels, bedX, bedY, bedShape])

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
