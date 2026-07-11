import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface Props {
  file: File
  /** Bed width (X axis) in mm — default 256 */
  bedX?: number
  /** Bed depth (Y axis) in mm — default 256 */
  bedY?: number
  /** Bed shape — 'circle' for delta/round printers, default 'rectangle' */
  bedShape?: 'rectangle' | 'circle'
}

function buildBed(
  scene: THREE.Scene,
  bedX: number,
  bedY: number,
  bedShape: 'rectangle' | 'circle',
): THREE.Object3D[] {
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
    grid.rotateX(Math.PI / 2)  // rotate from XZ plane to XY plane (Z-up floor)
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
    grid.rotateX(Math.PI / 2)  // rotate from XZ plane to XY plane (Z-up floor)
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

export function ModelViewer({ file, bedX = 256, bedY = 256, bedShape = 'rectangle' }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return
    setLoadError(null)

    const w = el.clientWidth
    const h = el.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf8fafc)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000)
    camera.up.set(0, 0, 1)  // Z-up to match engine coordinate system

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(100, 100, 200)  // Z-up: light comes from above (high Z)
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
    let mesh: THREE.Mesh | null = null
    let cancelled = false

    file.arrayBuffer().then((buffer) => {
      if (cancelled) return

      let geometry: THREE.BufferGeometry
      try {
        geometry = loader.parse(buffer)
      } catch {
        setLoadError('Could not read this model file')
        return
      }
      geometry.computeBoundingBox()
      const box = geometry.boundingBox!
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())

      // Centre X/Y on bed origin; place bottom at Z=0 (engine: X/Y flat, Z = height)
      geometry.translate(-center.x, -center.y, -box.min.z)

      const material = new THREE.MeshPhongMaterial({
        color: 0x0a84ff,
        specular: 0x222222,
        shininess: 30,
        side: THREE.DoubleSide,
      })
      mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      scene.add(mesh)

      // Fit camera to model — Z-up: position camera above and to the side
      const maxDim = Math.max(size.x, size.y, size.z, 50)
      const dist = maxDim * 2.5
      camera.position.set(dist * 0.6, -dist, dist * 0.7)
      controls.target.set(0, 0, size.z / 2)
      controls.update()
    }).catch(() => {
      if (!cancelled) setLoadError('Could not read this model file')
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
      mesh?.geometry.dispose()
      ;(mesh?.material as THREE.Material | undefined)?.dispose()
      for (const obj of bedObjects) {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose()
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose())
          } else {
            ;(obj.material as THREE.Material).dispose()
          }
        }
      }
      el.removeChild(renderer.domElement)
    }
  }, [file, bedX, bedY, bedShape])

  return (
    <div className="relative w-full h-full min-h-48">
      <div
        ref={mountRef}
        className="w-full h-full rounded-xl overflow-hidden"
        style={{ touchAction: 'none' }}
      />
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/80 text-sm text-slate-500">
          {loadError}
        </div>
      )}
    </div>
  )
}
