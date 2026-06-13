import type { OrcaModule, WorkerInMessage, WorkerOutMessage } from '../types'
import { sliceStl, OrcaSliceError } from '../lib/wasm-loader'

let orcaModule: OrcaModule | null = null
let loadingWasm = false
// Slice request that arrived before WASM was ready
let pendingSlice: { stl: ArrayBuffer; config: Record<string, unknown> } | null = null

function send(msg: WorkerOutMessage) {
  self.postMessage(msg)
}

send({ type: 'WORKER_READY' })

self.addEventListener('message', async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data

  if (msg.type === 'LOAD_WASM') {
    if (orcaModule) {
      send({ type: 'WASM_LOADED' })
      return
    }
    if (loadingWasm) return // already in flight
    loadingWasm = true

    try {
      const wasmBase = msg.url.replace(/\/slicer\.js$/, '')

      // Fetch slicer.js text and wasm binary in parallel
      const [jsText, wasmBinary] = await Promise.all([
        fetch(`${wasmBase}/slicer.js`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} fetching slicer.js`)
          return r.text()
        }),
        fetch(`${wasmBase}/slicer.wasm`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} fetching slicer.wasm`)
          return r.arrayBuffer()
        }),
      ])

      // Wrap Emscripten CommonJS output as an ES module default export.
      // slicer.js uses `var OrcaModule = ...` at module scope, so the appended
      // export default can see it in the same blob-URL ES module scope.
      const blob = new Blob(
        [`${jsText}\nexport default OrcaModule;`],
        { type: 'application/javascript' },
      )
      const blobUrl = URL.createObjectURL(blob)

      let factory: (opts: unknown) => Promise<OrcaModule>
      try {
        const mod = await import(/* @vite-ignore */ blobUrl) as { default: (opts: unknown) => Promise<OrcaModule> }
        factory = mod.default
      } finally {
        URL.revokeObjectURL(blobUrl)
      }

      // The v2.3.2 engine has no slicer.data (the orca/resources preload was
      // dropped — verified that headless slicing never reads /resources), so
      // there is nothing to fetch or reassemble here.

      orcaModule = await factory({
        wasmBinary,
        locateFile: (path: string) => `${wasmBase}/${path}`,
        printErr: (m: string) => console.warn('[OrcaWASM]', m),
        onAbort: (m: string) => console.error('[OrcaWASM abort]', m),
      })

      loadingWasm = false
      send({ type: 'WASM_LOADED' })

      // Fire any slice that queued up during loading
      if (pendingSlice) {
        const { stl, config } = pendingSlice
        pendingSlice = null
        doSlice(stl, config)
      }
    } catch (err) {
      loadingWasm = false
      send({
        type: 'WASM_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  if (msg.type === 'SLICE') {
    if (!orcaModule) {
      // WASM not ready yet — queue and wait
      pendingSlice = { stl: msg.stl, config: msg.config as Record<string, unknown> }
      return
    }
    doSlice(msg.stl, msg.config as Record<string, unknown>)
  }
})

function doSlice(stl: ArrayBuffer, config: Record<string, unknown>) {
  if (!orcaModule) return
  try {
    const configJson = JSON.stringify(config)
    const gcode = sliceStl(orcaModule, new Uint8Array(stl), configJson)
    send({ type: 'SLICE_COMPLETE', gcode })
  } catch (err) {
    if (err instanceof OrcaSliceError) {
      send({ type: 'SLICE_ERROR', code: err.code, message: err.message })
    } else {
      send({ type: 'SLICE_ERROR', code: -1, message: String(err) })
    }
  }
}
