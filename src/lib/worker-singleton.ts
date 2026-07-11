// Module-level singleton — survives React StrictMode double-mount,
// so WASM is loaded only once per browser session.
import type { WorkerOutMessage } from '../types'

type Listener = (msg: WorkerOutMessage) => void

let worker: Worker | null = null
const listeners = new Set<Listener>()

export type WasmStatus = 'idle' | 'loading' | 'ready' | 'error'
let wasmStatus: WasmStatus = 'idle'

export function getWasmStatus(): WasmStatus { return wasmStatus }

export function addWorkerListener(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Hard-stop the current worker (user-initiated cancel). The WASM slice loop
 * is synchronous inside the worker, so terminating the worker is the only
 * way to abort a running slice. The next getWorker() call spawns a fresh
 * worker and reloads the engine (served from the service-worker cache after
 * the first load, so the restart is cheap).
 */
export function terminateWorker(): void {
  worker?.terminate()
  worker = null
  wasmStatus = 'idle'
}

export function getWorker(): Worker {
  if (worker) return worker

  worker = new Worker(
    new URL('../workers/slicer.worker.ts', import.meta.url),
    { type: 'module' },
  )

  worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
    const msg = e.data
    if (msg.type === 'WASM_LOADED') {
      wasmStatus = 'ready'
    } else if (msg.type === 'WASM_ERROR') {
      wasmStatus = 'error'
      // Whether the module failed to load or aborted mid-session, this
      // worker's WASM instance is unusable from here on (Emscripten has no
      // "reload after abort" path). Drop it so the next getWorker() call
      // spawns a clean worker + reloads the engine from scratch, rather than
      // leaving the app permanently stuck on a dead instance until a full
      // page reload.
      worker?.terminate()
      worker = null
    }
    listeners.forEach((fn) => fn(msg))
  }

  worker.onerror = (e) => {
    wasmStatus = 'error'
    worker?.terminate()
    worker = null
    const msg: WorkerOutMessage = { type: 'WASM_ERROR', message: e.message ?? 'Worker crashed' }
    listeners.forEach((fn) => fn(msg))
  }

  // In production Vite sets BASE_URL to the app base (e.g. /OrcaWeb/app/).
  // WASM files live in public/wasm/ which gets deployed at <BASE_URL>wasm/.
  const wasmBase = import.meta.env.VITE_WASM_BASE_URL
    ?? `${import.meta.env.BASE_URL}wasm`
  wasmStatus = 'loading'
  // __WASM_VERSION__ (not __APP_VERSION__) — tracks the WASM engine build itself,
  // so an engine-only change (bridge/API) busts the cache even without an app
  // release. See vite.config.ts and deploy.yml's "Download WASM artifacts" step.
  // __ORCA_ENGINE_VERSION__ is separate: a human-readable label for console
  // diagnostics only, never used for the cache-busting URL itself.
  worker.postMessage({
    type: 'LOAD_WASM',
    url: `${wasmBase}/slicer.js`,
    version: __WASM_VERSION__,
    engineLabel: __ORCA_ENGINE_VERSION__,
  })

  return worker
}

// Call once at app startup to pre-warm WASM
export function preloadWasm(): void {
  if (wasmStatus === 'idle') getWorker()
}
