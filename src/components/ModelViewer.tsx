import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

interface Props {
  file: File
  /** Bed width (X axis) in mm — default 256 */
  bedX?: number
  /** Bed depth (Y axis) in mm — default 256 */
  bedY?: number
}

export function ModelViewer({ file, bedX = 256, bedY = 256 }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const w = el.clientWidth
    const h = el.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf8fafc)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(w, h)
    renderer.shadowMap.enabled = true
    el.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(100, 200, 100)
    dirLight.castShadow = true
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0x8ab4f8, 0.3)
    fillLight.position.set(-100, -50, -100)
    scene.add(fillLight)

    // Print bed: centred at origin, Y=0
    const bedGeo = new THREE.PlaneGeometry(bedX, bedY)
    bedGeo.rotateX(-Math.PI / 2)
    const bedMat = new THREE.MeshPhongMaterial({ color: 0xe2e8f0, side: THREE.DoubleSide })
    const bed = new THREE.Mesh(bedGeo, bedMat)
    bed.receiveShadow = true
    scene.add(bed)

    const gridDiv = Math.round(Math.max(bedX, bedY) / 10)
    const grid = new THREE.GridHelper(Math.max(bedX, bedY), gridDiv, 0xcccccc, 0xdde3ed)
    grid.scale.set(bedX / Math.max(bedX, bedY), 1, bedY / Math.max(bedX, bedY))
    grid.position.y = 0.1
    scene.add(grid)

    // Bed border
    const innerBoxGeo = new THREE.BoxGeometry(bedX, 0.5, bedY)
    const edgeGeo = new THREE.EdgesGeometry(innerBoxGeo)
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xb0bec5 })
    scene.add(new THREE.LineSegments(edgeGeo, edgeMat))

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

      const geometry = loader.parse(buffer)
      geometry.computeBoundingBox()
      const box = geometry.boundingBox!
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())

      // Centre X/Z on bed origin; place bottom at Y=0
      geometry.translate(-center.x, -box.min.y, -center.z)

      const material = new THREE.MeshPhongMaterial({
        color: 0x0a84ff,
        specular: 0x222222,
        shininess: 30,
        side: THREE.DoubleSide,
      })
      mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      scene.add(mesh)

      // Fit camera to model
      const maxDim = Math.max(size.x, size.y, size.z, 50)
      const dist = maxDim * 2.5
      camera.position.set(dist * 0.6, dist * 0.7, dist)
      controls.target.set(0, size.y / 2, 0)
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
      mesh?.geometry.dispose()
      ;(mesh?.material as THREE.Material | undefined)?.dispose()
      bedGeo.dispose()
      bedMat.dispose()
      innerBoxGeo.dispose()
      edgeGeo.dispose()
      edgeMat.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [file, bedX, bedY])

  return (
    <div
      ref={mountRef}
      className="w-full h-full min-h-48 rounded-xl overflow-hidden"
      style={{ touchAction: 'none' }}
    />
  )
}
