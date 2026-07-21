// Cached across calls — the result can't change within a session and every
// 3D viewer mount would otherwise create + discard a throwaway canvas/context.
let cached: boolean | null = null

/**
 * Probes for WebGL support without touching Three.js. Constructing
 * THREE.WebGLRenderer directly throws when no context is available (e.g. a
 * sandboxed/headless browser with no GPU passthrough), and that throw
 * happens inside a useEffect with no error boundary above it, which takes
 * down the whole React tree — so callers must check this first.
 */
export function isWebGLAvailable(): boolean {
  if (cached !== null) return cached
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ??
      canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false })
    cached = gl !== null
  } catch {
    cached = false
  }
  return cached
}
