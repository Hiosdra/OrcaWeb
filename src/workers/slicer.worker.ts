import type { OrcaConfig, OrcaModuleFactory, OrcaModule, WorkerInMessage, WorkerOutMessage } from '../types'
import { sliceStl, sliceMultiStl, objToStl, cadToStl, OrcaSliceError } from '../lib/wasm-loader'
import { toEngineConfig } from '../lib/profiles'
import { logInfo, logWarn, logError } from '../lib/log'

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
let pendingSlice: { stl: ArrayBuffer; config: OrcaConfig } | null = null
let pendingPlate: { stls: ArrayBuffer[]; config: OrcaConfig; extruderIds?: number[] } | null = null
const pendingObjConvertQueue: { obj: ArrayBuffer; requestId: string }[] = []
const pendingCadConvertQueue: { cad: ArrayBuffer; requestId: string }[] = []

function send(msg: WorkerOutMessage) {
  self.postMessage(msg)
}

self.addEventListener('message', async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data

  // Once the engine has aborted, fail every work request immediately instead
  // of queueing it (it would never resolve) or calling into the dead module
  // (undefined behaviour post-abort). worker-singleton.ts drops this worker
  // on the resulting *_ERROR and spawns a fresh one on the next request.
  if (wasmCrashed) {
    const crashMsg = 'Slicer engine crashed and cannot continue — reload to restart it'
    switch (msg.type) {
      case 'SLICE': send({ type: 'SLICE_ERROR', code: -9, message: crashMsg }); break
      case 'SLICE_MULTI': send({ type: 'SLICE_MULTI_ERROR', code: -9, message: crashMsg }); break
      case 'OBJ_TO_STL': send({ type: 'OBJ_STL_ERROR', message: crashMsg, requestId: msg.requestId }); break
      case 'CAD_TO_STL': send({ type: 'CAD_STL_ERROR', message: crashMsg, requestId: msg.requestId }); break
      case 'LOAD_WASM': send({ type: 'WASM_ERROR', message: crashMsg }); break
    }
    return
  }

  if (msg.type === 'LOAD_WASM') {
    if (orcaModule) {
      send({ type: 'WASM_LOADED' })
      return
    }
    if (loadingWasm) return // already in flight
    loadingWasm = true

    // Anchors every "how long did loading take" / "which build actually loaded"
    // question a user might otherwise have to ask us to debug — the earlier
    // "Engine error" incident was hard to diagnose precisely because nothing
    // useful was logged before the failure.
    const loadStartedAt = performance.now()
    logInfo(`[OrcaWASM] loading engine ${msg.engineLabel} from ${msg.url}`)

    try {
      const wasmBase = msg.url.replace(/\/slicer\.js$/, '')
      // slicer.js/slicer.wasm (and slicer-mt.js/slicer-mt.wasm) are served
      // under fixed, unhashed filenames (they're downloaded from the
      // wasm-v2.4.2 GitHub Release at deploy time, not processed by Vite's
      // asset pipeline, so they get no content-hash filename the way JS/CSS
      // bundles do). The PWA service worker caches them with a CacheFirst
      // strategy (vite.config.ts) that never revalidates against the
      // network — so without a cache-busting key in the URL, a browser that
      // visited before this deploy keeps serving its stale cached engine
      // binary indefinitely (up to the 30-day TTL), even after the rest of
      // the app updates to a new version. msg.version is __WASM_VERSION__
      // (the resolved WASM release tag, not the app version — see
      // worker-singleton.ts / vite.config.ts), so this key changes whenever
      // the engine binary changes, even between app releases. That makes
      // each engine build's URL genuinely new, so CacheFirst treats it as a
      // fresh entry instead of reusing a stale, API-mismatched one.
      const v = `?v=${encodeURIComponent(msg.version)}`

      // Dual-mode engine selection (orca-wasm/MT-PLAN.md Phase 2/3): the
      // real multithreaded engine (slicer-mt.*, built with -pthread against
      // orca-wasm/wasm/shims-mt/) needs SharedArrayBuffer, which needs
      // COOP/COEP response headers — unavailable on GitHub Pages (today's
      // demo host) but available on a properly configured production host
      // (e.g. .github/workflows/deploy-cloudflare-pages.yml). Same pattern
      // already proven end-to-end in poc/wasm-threads/public/worker.js.
      const canUseThreads =
        typeof SharedArrayBuffer !== 'undefined' &&
        (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true

      // crossOriginIsolated tells us what the *browser* can do, not what
      // files this *host* actually shipped — e.g. the Vite dev server (used
      // by e2e/slice.spec.ts) always sends COOP/COEP, but `npm run setup`
      // only ever downloads the ST slicer.js/slicer.wasm, and slicer-mt.*
      // isn't published for PR builds at all (build-wasm.yml only publishes
      // releases on non-PR events). Blindly requesting slicer-mt.js there
      // fails to parse as a JS module with a cryptic "Unexpected token '<'"
      // — Vite's dev server (and most static hosts' SPA fallback) answers a
      // missing path with a 200 OK text/html page, not a 404, so checking
      // `probe.ok` alone doesn't catch it; the content-type must be checked
      // too. Probe for the real file first and fall back to the
      // always-present ST engine rather than assuming capability implies
      // availability.
      let variant: 'slicer' | 'slicer-mt' = 'slicer'
      if (canUseThreads) {
        try {
          let probe: Response
          try {
            probe = await fetch(`${wasmBase}/slicer-mt.js${v}`, { method: 'HEAD' })
            if (!probe.ok) {
              probe = await fetch(`${wasmBase}/slicer-mt.js${v}`, {
                headers: { Range: 'bytes=0-0' },
              })
            }
          } catch {
            probe = await fetch(`${wasmBase}/slicer-mt.js${v}`, {
              headers: { Range: 'bytes=0-0' },
            })
          }
          const contentType = probe.headers.get('content-type') ?? ''
          if (probe.ok && !contentType.includes('text/html')) variant = 'slicer-mt'
          await probe.body?.cancel()
        } catch {
          // Network error probing — fall back to the ST engine.
        }
      }

      // Compile <variant>.wasm while <variant>.js is still downloading.
      // compileStreaming overlaps download and compilation (a measurable win
      // on a ~29 MB binary over slow links); it requires an
      // `application/wasm` Content-Type, so fall back to buffered
      // WebAssembly.compile when a server (or a proxy) mislabels the file.
      const wasmModulePromise = (async () => {
        const res = await fetch(`${wasmBase}/${variant}.wasm${v}`)
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${variant}.wasm`)
        if (
          typeof WebAssembly.compileStreaming === 'function'
          && res.headers.get('content-type')?.includes('application/wasm')
        ) {
          return WebAssembly.compileStreaming(res)
        }
        return WebAssembly.compile(await res.arrayBuffer())
      })()

      const jsText = await fetch(`${wasmBase}/${variant}.js${v}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${variant}.js`)
        return r.text()
      })
      logInfo(
        `[OrcaWASM] fetched slicer.js (${(jsText.length / 1024).toFixed(0)} KB) `
        + `in ${Math.round(performance.now() - loadStartedAt)}ms (wasm compiling in parallel)`,
      )

      // Wrap Emscripten CommonJS output as an ES module default export.
      // slicer.js uses `var OrcaModule = ...` at module scope, so the appended
      // export default can see it in the same blob-URL ES module scope.
      const blob = new Blob(
        [`${jsText}\nexport default OrcaModule;`],
        { type: 'application/javascript' },
      )
      const blobUrl = URL.createObjectURL(blob)

      let factory: OrcaModuleFactory
      try {
        const mod = await import(/* @vite-ignore */ blobUrl) as { default: OrcaModuleFactory }
        factory = mod.default
      } finally {
        URL.revokeObjectURL(blobUrl)
      }

      // The v2.4.2 engine has no slicer.data (the orca/resources preload was
      // dropped — verified that headless slicing never reads /resources), so
      // there is nothing to fetch or reassemble here.

      // Emscripten's instantiateWasm hook has no error channel: if the
      // supplied promise rejects and successCallback is never called, the
      // factory promise simply never settles. Race it against our own
      // rejection so a failed fetch/compile surfaces as WASM_ERROR instead
      // of hanging the load forever.
      let failInstantiate: (err: unknown) => void
      const instantiateFailed = new Promise<never>((_, reject) => { failInstantiate = reject })
      orcaModule = await Promise.race([
        factory({
          instantiateWasm: (imports, successCallback) => {
            wasmModulePromise
              .then((module) => WebAssembly.instantiate(module, imports))
              .then((instance) => successCallback(instance))
              .catch((err) => failInstantiate(err))
            return {} // instance is delivered asynchronously via successCallback
          },
          locateFile: (path: string) => `${wasmBase}/${path}${v}`,
          printErr: (m: string) => logWarn('[OrcaWASM]', m),
          onAbort: (m: string) => {
            logError('[OrcaWASM abort]', m)
            wasmCrashed = true
            send({ type: 'WASM_ERROR', message: `Slicer engine crashed: ${m}` })
          },
          // Needed with MODULARIZE + pthreads: this glue script is loaded via
          // a blob: URL (see below), so Emscripten's runtime can't infer its
          // real network URL to reload itself into nested pthread Workers
          // without this — found the hard way building poc/wasm-threads/
          // (see public/worker.js there for the same fix). Harmless/unused on
          // the ST variant, so it's fine to just always pass it.
          ...(variant === 'slicer-mt' ? { mainScriptUrlOrBlob: `${wasmBase}/${variant}.js${v}` } : {}),
        }),
        instantiateFailed,
      ])

      session = orcaModule._orc_session_create()
      if (!session) {
        orcaModule = null
        loadingWasm = false
        logError(`[OrcaWASM] session allocation failed after ${Math.round(performance.now() - loadStartedAt)}ms`)
        send({ type: 'WASM_ERROR', message: 'Failed to allocate slicer session (out of memory?)' })
        return
      }

      loadingWasm = false
      logInfo(
        `[OrcaWASM] engine ${msg.engineLabel} ready in ${Math.round(performance.now() - loadStartedAt)}ms — session #${session}`,
      )
      send({ type: 'WASM_LOADED' })

      // Fire any requests that queued up during loading
      for (const pending of pendingObjConvertQueue) {
        doObjToStl(pending.obj, pending.requestId)
      }
      pendingObjConvertQueue.length = 0
      for (const pending of pendingCadConvertQueue) {
        doCadToStl(pending.cad, pending.requestId)
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
      logError(
        `[OrcaWASM] engine ${msg.engineLabel} failed to load after ${Math.round(performance.now() - loadStartedAt)}ms:`,
        err,
      )
      send({
        type: 'WASM_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  switch (msg.type) {
    case 'SLICE':
      if (!orcaModule) {
        pendingSlice = { stl: msg.stl, config: msg.config }
        return
      }
      doSlice(msg.stl, msg.config)
      return
    case 'SLICE_MULTI':
      if (!orcaModule) {
        pendingPlate = { stls: msg.stls, config: msg.config, extruderIds: msg.extruderIds }
        return
      }
      doSliceMulti(msg.stls, msg.config, msg.extruderIds)
      return
    case 'OBJ_TO_STL':
      if (!orcaModule) {
        pendingObjConvertQueue.push({ obj: msg.obj, requestId: msg.requestId })
        return
      }
      doObjToStl(msg.obj, msg.requestId)
      return
    case 'CAD_TO_STL':
      if (!orcaModule) {
        pendingCadConvertQueue.push({ cad: msg.cad, requestId: msg.requestId })
        return
      }
      doCadToStl(msg.cad, msg.requestId)
      return
    default:
      msg satisfies never
  }
})

// A handful of settings that most affect print time/quality, picked to match
// what ConfigSummary (App.tsx) already shows users — not an exhaustive dump of
// the config, just enough to tell slices apart from each other in the console.
function summarizeConfig(config: OrcaConfig): string {
  const parts: string[] = []
  if (config.layer_height != null) parts.push(`layer ${config.layer_height}mm`)
  if (config.filament_type != null) parts.push(String(config.filament_type))
  if (config.sparse_infill_density != null) parts.push(`infill ${config.sparse_infill_density}%`)
  if (config.wall_loops != null) parts.push(`${config.wall_loops} walls`)
  if (config.enable_support) parts.push('supports')
  return parts.length ? parts.join(', ') : '(defaults)'
}

function doObjToStl(obj: ArrayBuffer, requestId: string) {
  if (!orcaModule) return
  try {
    const stl = objToStl(orcaModule, new Uint8Array(obj))
    const stlBuffer = stl.buffer as ArrayBuffer
    self.postMessage({ type: 'OBJ_STL_COMPLETE', stl: stlBuffer, requestId }, [stlBuffer])
  } catch (err) {
    send({ type: 'OBJ_STL_ERROR', message: err instanceof Error ? err.message : String(err), requestId })
  }
}

function doSliceMulti(stls: ArrayBuffer[], config: OrcaConfig, extruderIds?: number[]) {
  if (!orcaModule) return
  const startedAt = performance.now()
  const totalMB = stls.reduce((sum, s) => sum + s.byteLength, 0) / 1e6
  logInfo(
    `[OrcaWASM] slice-multi start — ${stls.length} STL(s), ${totalMB.toFixed(2)} MB total, `
    + `${summarizeConfig(config)}${extruderIds ? `, extruders [${extruderIds.join(',')}]` : ''}`,
  )
  try {
    const { _passthrough, ...rest } = config
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
    logInfo(
      `[OrcaWASM] slice-multi done in ${Math.round(performance.now() - startedAt)}ms `
      + `— G-code ${(gcode.length / 1e6).toFixed(2)} MB`,
    )
    send({ type: 'SLICE_MULTI_COMPLETE', gcode })
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt)
    if (err instanceof OrcaSliceError) {
      logError(`[OrcaWASM] slice-multi failed after ${ms}ms — code ${err.code}: ${err.message}`)
      send({ type: 'SLICE_MULTI_ERROR', code: err.code, message: err.message })
    } else {
      logError(`[OrcaWASM] slice-multi failed after ${ms}ms:`, err)
      send({ type: 'SLICE_MULTI_ERROR', code: -1, message: String(err) })
    }
  }
}

function doCadToStl(cad: ArrayBuffer, requestId: string) {
  if (!orcaModule) return
  try {
    const stl = cadToStl(orcaModule, new Uint8Array(cad))
    const stlBuffer = stl.buffer as ArrayBuffer
    self.postMessage({ type: 'CAD_STL_COMPLETE', stl: stlBuffer, requestId }, [stlBuffer])
  } catch (err) {
    send({ type: 'CAD_STL_ERROR', message: err instanceof Error ? err.message : String(err), requestId })
  }
}

function doSlice(stl: ArrayBuffer, config: OrcaConfig) {
  if (!orcaModule) return
  const startedAt = performance.now()
  logInfo(`[OrcaWASM] slice start — STL ${(stl.byteLength / 1e6).toFixed(2)} MB, ${summarizeConfig(config)}`)
  try {
    const { _passthrough, ...rest } = config
    const engineRest = toEngineConfig(rest)
    const flat = _passthrough ? { ...engineRest, ..._passthrough } : engineRest
    const configJson = JSON.stringify(flat)
    const gcode = sliceStl(orcaModule, session, new Uint8Array(stl), configJson)
    logInfo(
      `[OrcaWASM] slice done in ${Math.round(performance.now() - startedAt)}ms `
      + `— G-code ${(gcode.length / 1e6).toFixed(2)} MB`,
    )
    send({ type: 'SLICE_COMPLETE', gcode })
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt)
    if (err instanceof OrcaSliceError) {
      logError(`[OrcaWASM] slice failed after ${ms}ms — code ${err.code}: ${err.message}`)
      send({ type: 'SLICE_ERROR', code: err.code, message: err.message })
    } else {
      logError(`[OrcaWASM] slice failed after ${ms}ms:`, err)
      send({ type: 'SLICE_ERROR', code: -1, message: String(err) })
    }
  }
}
