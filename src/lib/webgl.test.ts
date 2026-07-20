import { afterEach, describe, expect, it, vi } from 'vitest'

// isWebGLAvailable() caches its result in a module-level variable, so each
// case needs a fresh module instance (vi.resetModules + dynamic import)
// rather than sharing the one import at the top of the file.

const originalDocument = (globalThis as { document?: unknown }).document

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document
  } else {
    ;(globalThis as { document?: unknown }).document = originalDocument
  }
})

function stubDocument(getContext: (type: string) => unknown) {
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => ({ getContext }),
  }
}

describe('isWebGLAvailable', () => {
  it('returns false without throwing when there is no document (e.g. run outside a browser)', async () => {
    vi.resetModules()
    delete (globalThis as { document?: unknown }).document
    const { isWebGLAvailable } = await import('./webgl')
    expect(isWebGLAvailable()).toBe(false)
  })

  it('returns false when both webgl2 and webgl contexts are unavailable', async () => {
    vi.resetModules()
    const getContext = vi.fn(() => null)
    stubDocument(getContext)
    const { isWebGLAvailable } = await import('./webgl')
    expect(isWebGLAvailable()).toBe(false)
    expect(getContext).toHaveBeenCalledWith('webgl2', { failIfMajorPerformanceCaveat: false })
    expect(getContext).toHaveBeenCalledWith('webgl', { failIfMajorPerformanceCaveat: false })
  })

  it('returns true when a webgl context is available, and caches the result', async () => {
    vi.resetModules()
    const getContext = vi.fn(() => ({}))
    stubDocument(getContext)
    const { isWebGLAvailable } = await import('./webgl')
    expect(isWebGLAvailable()).toBe(true)
    expect(isWebGLAvailable()).toBe(true)
    expect(getContext).toHaveBeenCalledTimes(1)
  })
})
