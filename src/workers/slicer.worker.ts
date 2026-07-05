import type { OrcaModule, WorkerInMessage, WorkerOutMessage } from '../types'
import { sliceStl, sliceMultiStl, objToStl, cadToStl, OrcaSliceError } from '../lib/wasm-loader'
import { toEngineConfig } from '../lib/profiles'

let orcaModule: OrcaModule | null = null
// Created once, right after the module loads, and reused for the worker's
// entire lifetime — behaviour-equivalent to the old global-state bridge, but
// via an explicit handle now that orca-wasm/bridge/slicer.cpp scopes engine
// state per-session instead of to process-wide statics.
let session = 0
let loadingWasm = false
// Set when the WASM module aborts at runtime (e.g. an unreachable trap or
// OOM inside a slice). Emscripten does not support resuming or reinitializing
// a module after abort() — every exported call after that point either
// throws immediately or hangs — so `orcaModule` staying non-null must not be
// read as "still usable". Once true, this worker refuses further work and
// tells the main thread its engine is dead so a fresh worker can be spawned
// instead of silently retrying against a corpse.
let wasmCrashed = false
// Slice request that arrived before WASM was ready — last-wins (UI disables
// the Slice button while loading, so only one request can queue in practice)
let pendingSlice: { stl: ArrayBuffer; config: Record<string, unknown> } | null = null
let pendingPlate: { stls: ArrayBuffer[]; config: Record<string, unknown>; extruderIds?: number[] } | null = null
const pendingObjConvertQueue: { obj: ArrayBuffer; filename: string }[] = []
const pendingCadConvertQueue: { cad: ArrayBuffer; filename: string }[] = []

function send(msg: WorkerOutMessage) {
  self.postMessage(msg)
}

send({ type: 'WORKER_READY' })

self.addEventListener('message', async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data

  // Once the engine has aborted, fail every work request immediately instead
  // of queueing it (it would never resolve) or calling into the dead module
  // (undefined behaviour post-abort). worker-singleton.ts drops this worker
  // on the resulting *_ERROR and spawns a fresh one on the next request.
  if (wasmCrashed) {
    const crashMsg = 'Slicer engine crashed and cannot continue — reload to restart it'
    if (msg.type === 'SLICE') send({ type: 'SLICE_ERROR', code: -9, message: crashMsg })
    else if (msg.type === 'SLICE_MULTI') send({ type: 'SLICE_MULTI_ERROR', code: -9, message: crashMsg })
    else if (msg.type === 'OBJ_TO_STL') send({ type: 'OBJ_STL_ERROR', message: crashMsg, filename: msg.filename })
    else if (msg.type === 'CAD_TO_STL') send({ type: 'CAD_STL_ERROR', message: crashMsg, filename: msg.filename })
    return
  }

  if (msg.type === 'LOAD_WASM') {
    if (orcaModule) {
      send({ type: 'WASM_LOADED' })
      return
    }
    if (loadingWasm) return // already in flight
    loadingWasm = true

    try {
      const wasmBase = msg.url.replace(/\/slicer\.js$/, '')
      // slicer.js/slicer.wasm are served under a fixed, unhashed filename
      // (they're downloaded from the wasm-v2.4.0 GitHub Release at deploy
      // time, not processed by Vite's asset pipeline, so they get no
      // content-hash filename the way JS/CSS bundles do). The PWA service
      // worker caches them with a CacheFirst strategy (vite.config.ts) that
      // never revalidates against the network — so without a cache-busting
      // key in the URL, a browser that visited before this deploy keeps
      // serving its stale cached engine binary indefinitely (up to the 30-day
      // TTL), even after the rest of the app updates to a new version.
      // msg.version is __WASM_VERSION__ (the resolved WASM release tag, not the
      // app version — see worker-singleton.ts / vite.config.ts), so this key
      // changes whenever the engine binary changes, even between app releases.
      // That makes each engine build's URL genuinely new, so CacheFirst treats
      // it as a fresh entry instead of reusing a stale, API-mismatched one.
      const v = `?v=${encodeURIComponent(msg.version)}`

      // Fetch slicer.js text and wasm binary in parallel
      const [jsText, wasmBinary] = await Promise.all([
        fetch(`${wasmBase}/slicer.js${v}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} fetching slicer.js`)
          return r.text()
        }),
        fetch(`${wasmBase}/slicer.wasm${v}`).then((r) => {
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

      // The v2.4.0 engine has no slicer.data (the orca/resources preload was
      // dropped — verified that headless slicing never reads /resources), so
      // there is nothing to fetch or reassemble here.

      orcaModule = await factory({
        wasmBinary,
        locateFile: (path: string) => `${wasmBase}/${path}${v}`,
        printErr: (m: string) => console.warn('[OrcaWASM]', m),
        onAbort: (m: string) => {
          console.error('[OrcaWASM abort]', m)
          wasmCrashed = true
          send({ type: 'WASM_ERROR', message: `Slicer engine crashed: ${m}` })
        },
      })

      session = orcaModule._orc_session_create()
      if (!session) {
        orcaModule = null
        loadingWasm = false
        send({ type: 'WASM_ERROR', message: 'Failed to allocate slicer session (out of memory?)' })
        return
      }

      loadingWasm = false
      send({ type: 'WASM_LOADED' })

      // Fire any requests that queued up during loading
      for (const pending of pendingObjConvertQueue) {
        doObjToStl(pending.obj, pending.filename)
      }
      pendingObjConvertQueue.length = 0
      for (const pending of pendingCadConvertQueue) {
        doCadToStl(pending.cad, pending.filename)
      }
      pendingCadConvertQueue.length = 0
      if (pendingSlice) {
        const { stl, config } = pendingSlice
        pendingSlice = null
        doSlice(stl, config)
      }
      if (pendingPlate) {
        const { stls, config, extruderIds } = pendingPlate
        pendingPlate = null
        doSliceMulti(stls, config, extruderIds)
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
      pendingPlate = { stls: msg.stls, config: msg.config as Record<string, unknown>, extruderIds: msg.extruderIds }
      return
    }
    doSliceMulti(msg.stls, msg.config as Record<string, unknown>, msg.extruderIds)
  }

  if (msg.type === 'OBJ_TO_STL') {
    if (!orcaModule) {
      pendingObjConvertQueue.push({ obj: msg.obj, filename: msg.filename })
      return
    }
    doObjToStl(msg.obj, msg.filename)
  }

  if (msg.type === 'CAD_TO_STL') {
    if (!orcaModule) {
      pendingCadConvertQueue.push({ cad: msg.cad, filename: msg.filename })
      return
    }
    doCadToStl(msg.cad, msg.filename)
  }
})

function doObjToStl(obj: ArrayBuffer, filename: string) {
  if (!orcaModule) return
  try {
    const stl = objToStl(orcaModule, new Uint8Array(obj))
    const stlBuffer = stl.buffer as ArrayBuffer
    self.postMessage({ type: 'OBJ_STL_COMPLETE', stl: stlBuffer, filename }, [stlBuffer])
  } catch (err) {
    send({ type: 'OBJ_STL_ERROR', message: err instanceof Error ? err.message : String(err), filename })
  }
}

function doSliceMulti(stls: ArrayBuffer[], config: Record<string, unknown>, extruderIds?: number[]) {
  if (!orcaModule) return
  try {
    const { _passthrough, ...rest } = config as Record<string, unknown> & { _passthrough?: Record<string, string> }
    const engineRest = toEngineConfig(rest)
    const flat = _passthrough ? { ...engineRest, ..._passthrough } : engineRest
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

    const extruderIdsArr = extruderIds && extruderIds.length === stls.length
      ? Int32Array.from(extruderIds)
      : undefined

    const gcode = sliceMultiStl(orcaModule, session, combined, offsets, stls.length, configJson, extruderIdsArr)
    send({ type: 'SLICE_MULTI_COMPLETE', gcode })
  } catch (err) {
    if (err instanceof OrcaSliceError) {
      send({ type: 'SLICE_MULTI_ERROR', code: err.code, message: err.message })
    } else {
      send({ type: 'SLICE_MULTI_ERROR', code: -1, message: String(err) })
    }
  }
}

function doCadToStl(cad: ArrayBuffer, filename: string) {
  if (!orcaModule) return
  try {
    const stl = cadToStl(orcaModule, new Uint8Array(cad))
    const stlBuffer = stl.buffer as ArrayBuffer
    self.postMessage({ type: 'CAD_STL_COMPLETE', stl: stlBuffer, filename }, [stlBuffer])
  } catch (err) {
    send({ type: 'CAD_STL_ERROR', message: err instanceof Error ? err.message : String(err), filename })
  }
}

function doSlice(stl: ArrayBuffer, config: Record<string, unknown>) {
  if (!orcaModule) return
  try {
    const { _passthrough, ...rest } = config as Record<string, unknown> & { _passthrough?: Record<string, string> }
    const engineRest = toEngineConfig(rest)
    const flat = _passthrough ? { ...engineRest, ..._passthrough } : engineRest
    const configJson = JSON.stringify(flat)
    const gcode = sliceStl(orcaModule, session, new Uint8Array(stl), configJson)
    send({ type: 'SLICE_COMPLETE', gcode })
  } catch (err) {
    if (err instanceof OrcaSliceError) {
      send({ type: 'SLICE_ERROR', code: err.code, message: err.message })
    } else {
      send({ type: 'SLICE_ERROR', code: -1, message: String(err) })
    }
  }
}
