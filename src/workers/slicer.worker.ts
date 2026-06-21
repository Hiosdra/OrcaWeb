import type { OrcaModule, WorkerInMessage, WorkerOutMessage } from '../types'
import { sliceStl, sliceMultiStl, objToStl, OrcaSliceError } from '../lib/wasm-loader'

let orcaModule: OrcaModule | null = null
let loadingWasm = false
// Slice request that arrived before WASM was ready — last-wins (UI disables
// the Slice button while loading, so only one request can queue in practice)
let pendingSlice: { stl: ArrayBuffer; config: Record<string, unknown> } | null = null
let pendingPlate: { stls: ArrayBuffer[]; config: Record<string, unknown> } | null = null
const pendingObjConvertQueue: { obj: ArrayBuffer; filename: string }[] = []

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

      // Fire any requests that queued up during loading
      for (const pending of pendingObjConvertQueue) {
        doObjToStl(pending.obj, pending.filename)
      }
      pendingObjConvertQueue.length = 0
      if (pendingSlice) {
        const { stl, config } = pendingSlice
        pendingSlice = null
        doSlice(stl, config)
      }
      if (pendingPlate) {
        const { stls, config } = pendingPlate
        pendingPlate = null
        doSliceMulti(stls, config)
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
      pendingSlice = { stl: msg.stl, config: msg.config as Record<string, unknown> }
      return
    }
    doSlice(msg.stl, msg.config as Record<string, unknown>)
  }

  if (msg.type === 'SLICE_MULTI') {
    if (!orcaModule) {
      pendingPlate = { stls: msg.stls, config: msg.config as Record<string, unknown> }
      return
    }
    doSliceMulti(msg.stls, msg.config as Record<string, unknown>)
  }

  if (msg.type === 'OBJ_TO_STL') {
    if (!orcaModule) {
      pendingObjConvertQueue.push({ obj: msg.obj, filename: msg.filename })
      return
    }
    doObjToStl(msg.obj, msg.filename)
  }
})

function doObjToStl(obj: ArrayBuffer, filename: string) {
  if (!orcaModule) return
  try {
    const stl = objToStl(orcaModule, new Uint8Array(obj))
    const stlBuffer = stl.buffer as ArrayBuffer
    self.postMessage({ type: 'OBJ_STL_COMPLETE', stl: stlBuffer, filename }, [stlBuffer])
  } catch (err) {
    send({ type: 'OBJ_STL_ERROR', message: err instanceof Error ? err.message : String(err) })
  }
}

function doSliceMulti(stls: ArrayBuffer[], config: Record<string, unknown>) {
  if (!orcaModule) return
  try {
    const { _passthrough, ...rest } = config as Record<string, unknown> & { _passthrough?: Record<string, string> }
    const flat = _passthrough ? { ...rest, ..._passthrough } : rest
    const configJson = JSON.stringify(flat)

    // Concatenate all STL buffers and build int32 offset table
    const totalLen = stls.reduce((sum, s) => sum + s.byteLength, 0)
    const combined = new Uint8Array(totalLen)
    const offsets = new Int32Array(stls.length * 2)
    let pos = 0
    for (let i = 0; i < stls.length; i++) {
      combined.set(new Uint8Array(stls[i]), pos)
      offsets[i * 2]     = pos
      offsets[i * 2 + 1] = stls[i].byteLength
      pos += stls[i].byteLength
    }

    const gcode = sliceMultiStl(orcaModule, combined, offsets, stls.length, configJson)
    send({ type: 'SLICE_MULTI_COMPLETE', gcode })
  } catch (err) {
    if (err instanceof OrcaSliceError) {
      send({ type: 'SLICE_MULTI_ERROR', code: err.code, message: err.message })
    } else {
      send({ type: 'SLICE_MULTI_ERROR', code: -1, message: String(err) })
    }
  }
}

function doSlice(stl: ArrayBuffer, config: Record<string, unknown>) {
  if (!orcaModule) return
  try {
    const { _passthrough, ...rest } = config as Record<string, unknown> & { _passthrough?: Record<string, string> }
    const flat = _passthrough ? { ...rest, ..._passthrough } : rest
    const configJson = JSON.stringify(flat)
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
