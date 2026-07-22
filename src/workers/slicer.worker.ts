import { logError, logInfo, logWarn } from '../lib/log'
import { toEngineConfig } from '../lib/profiles'
import { cadToStl, OrcaSliceError, objToStl, read3mf, sliceMultiStl, sliceStl, write3mf } from '../lib/wasm-loader'
import type { OrcaConfig, OrcaModule, OrcaModuleFactory, WorkerInMessage, WorkerOutMessage } from '../types'

// A genuinely stalled connection (TCP connected but the server/proxy never
// answers — as opposed to a slow-but-progressing download) previously left
// the LOAD_WASM fetch()es pending forever, since neither ever resolves or
// rejects: no WASM_LOADED/WASM_ERROR is ever sent, so anything awaiting the
// engine (e.g. a 3MF import) hangs indefinitely with no fallback. The
// timeout here only bounds *time to first response* — fetch()'s promise
// settles as soon as headers arrive, well before the body (tens of MB for
// slicer.wasm) finishes streaming, so a legitimately slow-but-working
// download is never aborted once it starts.
const FETCH_RESPONSE_TIMEOUT_MS = 30_000

// Separate, much shorter budget for the tiny engine-version.json manifest
// (a few dozen bytes): if it's slow or stalled we want to fall back to the
// build-time baked version fast rather than block the whole engine load — the
// 30s engine-download budget above would be a worse UX than the staleness bug
// the manifest is there to fix.
const MANIFEST_FETCH_TIMEOUT_MS = 4_000

function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

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
let pendingSlice: { stl: ArrayBuffer; config: OrcaConfig; extruderId?: number } | null = null
let pendingPlate: { stls: ArrayBuffer[]; config: OrcaConfig; extruderIds?: number[] } | null = null
const pendingObjConvertQueue: { obj: ArrayBuffer; requestId: string }[] = []
const pendingCadConvertQueue: { cad: ArrayBuffer; requestId: string }[] = []
const pendingWrite3mfQueue: { stl: ArrayBuffer; config: OrcaConfig; requestId: string }[] = []
const pendingRead3mfQueue: { mf: ArrayBuffer; requestId: string }[] = []

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
      case 'SLICE':
        send({ type: 'SLICE_ERROR', code: -9, message: crashMsg })
        break
      case 'SLICE_MULTI':
        send({ type: 'SLICE_MULTI_ERROR', code: -9, message: crashMsg })
        break
      case 'OBJ_TO_STL':
        send({ type: 'OBJ_STL_ERROR', message: crashMsg, requestId: msg.requestId })
        break
      case 'CAD_TO_STL':
        send({ type: 'CAD_STL_ERROR', message: crashMsg, requestId: msg.requestId })
        break
      case 'WRITE_3MF':
        send({ type: 'WRITE_3MF_ERROR', message: crashMsg, requestId: msg.requestId })
        break
      case 'READ_3MF':
        send({ type: 'READ_3MF_ERROR', message: crashMsg, requestId: msg.requestId })
        break
      case 'LOAD_WASM':
        send({ type: 'WASM_ERROR', message: crashMsg })
        break
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

    // Resolved at runtime from engine-version.json below; msg.version /
    // msg.engineLabel (baked into this app bundle at build time) are only the
    // fallback. Declared out here so the catch block can log the label too.
    let version = msg.version
    let engineLabel = msg.engineLabel

    try {
      const wasmBase = msg.url.replace(/\/slicer\.js$/, '')
      // Resolve the engine version + label at RUNTIME from engine-version.json
      // (published next to the binaries by deploy.yml), rather than trusting
      // the value baked into this app bundle at build time. Why: the Cloudflare
      // app shell and the engine are produced by two independent pipelines
      // racing off the same push — the shell (a ~2 min Vite build) routinely
      // finishes before build-wasm.yml has compiled and mirrored the new
      // engine, so the baked __WASM_VERSION__ can point at a stale (even
      // deadlocking) engine, and the CacheFirst ?v= key would stay stuck there
      // until the shell is rebuilt. Reading the manifest here makes the shell
      // track whatever engine is actually live, with no rebuild needed.
      // engine-version.json is tiny and deliberately NOT service-worker cached
      // (see vite.config.ts globIgnores/runtimeCaching); cache:'no-store' also
      // bypasses the HTTP cache, so this is always fresh. Falls back to the
      // baked values when the manifest is absent (local dev before
      // `npm run setup`) or unreachable.
      // One small round-trip serialized in front of the engine download (the
      // version must be known before the ?v= URL can be built), bounded by the
      // short MANIFEST_FETCH_TIMEOUT_MS so a stalled manifest can't hold up the
      // load — a deliberate trade-off for always tracking the live engine.
      try {
        const manifestRes = await fetchWithTimeout(`${wasmBase}/engine-version.json`, MANIFEST_FETCH_TIMEOUT_MS, {
          cache: 'no-store',
        })
        if (manifestRes.ok) {
          const manifest = (await manifestRes.json()) as unknown
          if (manifest && typeof manifest === 'object') {
            const m = manifest as { version?: unknown; label?: unknown }
            if (typeof m.version === 'string' && m.version) version = m.version
            if (typeof m.label === 'string' && m.label) engineLabel = m.label
          }
        }
      } catch {
        // Manifest missing/unreachable/slow — keep the build-time baked fallback.
      }

      // The engine files are served under fixed, unhashed filenames (downloaded
      // from the GitHub Release at deploy time, not through Vite's asset
      // pipeline, so they get no content-hash filename). The PWA service worker
      // caches them CacheFirst (vite.config.ts) and never revalidates, so
      // without a cache-busting key a browser that visited before an engine
      // update keeps serving its stale cached binary. `version` (resolved just
      // above) changes whenever the engine changes, making each engine's URL
      // genuinely new so CacheFirst treats it as a fresh entry.
      const v = `?v=${encodeURIComponent(version)}`

      // Dual-mode engine selection (see ADR-011): the real
      // multithreaded engine (slicer-mt.*, built with -pthread against real
      // oneTBB) needs SharedArrayBuffer, which needs COOP/COEP response
      // headers — unavailable on GitHub Pages (the primary deployment) but
      // sent by the Cloudflare mirror (public/_headers; see cf-build.mjs and
      // wrangler.jsonc for that host's setup). Same pattern already proven
      // end-to-end in poc/wasm-threads/public/worker.js.
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
          const probeUrl = `${wasmBase}/slicer-mt.js${v}`
          // Prefer a HEAD (no body); some static hosts answer HEAD with 405,
          // so fall back to a 1-byte Range GET. A single catch covers both a
          // HEAD that throws and a HEAD that returns !ok.
          let probe = await fetchWithTimeout(probeUrl, FETCH_RESPONSE_TIMEOUT_MS, { method: 'HEAD' }).catch(() => null)
          if (!probe?.ok) {
            probe = await fetchWithTimeout(probeUrl, FETCH_RESPONSE_TIMEOUT_MS, { headers: { Range: 'bytes=0-0' } })
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
        const res = await fetchWithTimeout(`${wasmBase}/${variant}.wasm${v}`, FETCH_RESPONSE_TIMEOUT_MS)
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${variant}.wasm`)
        if (
          typeof WebAssembly.compileStreaming === 'function' &&
          res.headers.get('content-type')?.includes('application/wasm')
        ) {
          return WebAssembly.compileStreaming(res)
        }
        return WebAssembly.compile(await res.arrayBuffer())
      })()

      const jsText = await fetchWithTimeout(`${wasmBase}/${variant}.js${v}`, FETCH_RESPONSE_TIMEOUT_MS).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${variant}.js`)
        return r.text()
      })
      logInfo(
        `[OrcaWASM] fetched slicer.js (${(jsText.length / 1024).toFixed(0)} KB) ` +
          `in ${Math.round(performance.now() - loadStartedAt)}ms (wasm compiling in parallel)`,
      )

      // Wrap Emscripten CommonJS output as an ES module default export.
      // slicer.js uses `var OrcaModule = ...` at module scope, so the appended
      // export default can see it in the same blob-URL ES module scope.
      const blob = new Blob([`${jsText}\nexport default OrcaModule;`], { type: 'application/javascript' })
      const blobUrl = URL.createObjectURL(blob)

      // Same-origin classic-worker script for Emscripten's pthread pool (MT
      // only). Emscripten spawns pool workers with `new Worker(mainScriptUrl
      // OrBlob)`; a classic Worker whose script URL is CROSS-origin throws a
      // SecurityError, so we must NOT hand it the cross-origin engine URL —
      // on the Cloudflare mirror `wasmBase` is the GitHub Pages origin, so the
      // raw URL string would fail there (never hit locally, where wasmBase is
      // same-origin). Passing a Blob makes Emscripten mint a same-origin
      // blob: URL for each worker instead. It's the *raw* glue (no ESM
      // `export default`, which would be a syntax error in a classic worker,
      // unlike the import blob above). Module retains this Blob, so any later
      // on-demand pool growth can still spawn workers from it.
      const pthreadScriptBlob = variant === 'slicer-mt' ? new Blob([jsText], { type: 'application/javascript' }) : null

      let factory: OrcaModuleFactory
      try {
        const mod = (await import(/* @vite-ignore */ blobUrl)) as { default: OrcaModuleFactory }
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
      const instantiateFailed = new Promise<never>((_, reject) => {
        failInstantiate = reject
      })
      orcaModule = await Promise.race([
        factory({
          instantiateWasm: (imports, successCallback) => {
            wasmModulePromise
              .then((module) => WebAssembly.instantiate(module, imports).then((instance) => ({ instance, module })))
              // Both instance AND module must reach successCallback — Emscripten's
              // internal receiveInstance(instance, module) stores module as
              // `wasmModule`, which pthread worker spawning (MT builds) reads to
              // share the compiled module with new pthread workers. Passing only
              // instance leaves wasmModule undefined and crashes every spawned
              // pthread worker (observed live: "Cannot read properties of
              // undefined (reading '...')" inside the newly spawned worker,
              // surfacing to the main thread only via onAbort/printErr, not as a
              // rejection here — hence the instantiateFailed race below).
              .then(({ instance, module }) => successCallback(instance, module))
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
          // Needed with MODULARIZE + pthreads: the main glue is imported from a
          // blob: URL, so Emscripten can't infer a script URL to spawn pthread
          // workers from. We hand it a same-origin Blob (see pthreadScriptBlob
          // above) rather than the engine URL, which is cross-origin on the
          // Cloudflare mirror and would make `new Worker(url)` throw. Only set
          // for MT (ST has no pthreads).
          ...(pthreadScriptBlob ? { mainScriptUrlOrBlob: pthreadScriptBlob } : {}),
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
        `[OrcaWASM] engine ${engineLabel} ready in ${Math.round(performance.now() - loadStartedAt)}ms — session #${session}`,
      )
      send({ type: 'WASM_LOADED', engineLabel })

      // Fire any requests that queued up during loading
      for (const pending of pendingObjConvertQueue) {
        doObjToStl(pending.obj, pending.requestId)
      }
      pendingObjConvertQueue.length = 0
      for (const pending of pendingCadConvertQueue) {
        doCadToStl(pending.cad, pending.requestId)
      }
      pendingCadConvertQueue.length = 0
      for (const pending of pendingWrite3mfQueue) {
        doWrite3mf(pending.stl, pending.config, pending.requestId)
      }
      pendingWrite3mfQueue.length = 0
      for (const pending of pendingRead3mfQueue) {
        doRead3mf(pending.mf, pending.requestId)
      }
      pendingRead3mfQueue.length = 0
      if (pendingSlice) {
        const { stl, config, extruderId } = pendingSlice
        pendingSlice = null
        doSlice(stl, config, extruderId)
      }
      if (pendingPlate) {
        const { stls, config, extruderIds } = pendingPlate
        pendingPlate = null
        doSliceMulti(stls, config, extruderIds)
      }
    } catch (err) {
      loadingWasm = false
      logError(
        `[OrcaWASM] engine ${engineLabel} failed to load after ${Math.round(performance.now() - loadStartedAt)}ms:`,
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
        pendingSlice = { stl: msg.stl, config: msg.config, extruderId: msg.extruderId }
        return
      }
      doSlice(msg.stl, msg.config, msg.extruderId)
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
    case 'WRITE_3MF':
      if (!orcaModule) {
        pendingWrite3mfQueue.push({ stl: msg.stl, config: msg.config, requestId: msg.requestId })
        return
      }
      doWrite3mf(msg.stl, msg.config, msg.requestId)
      return
    case 'READ_3MF':
      if (!orcaModule) {
        pendingRead3mfQueue.push({ mf: msg.mf, requestId: msg.requestId })
        return
      }
      doRead3mf(msg.mf, msg.requestId)
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
    `[OrcaWASM] slice-multi start — ${stls.length} STL(s), ${totalMB.toFixed(2)} MB total, ` +
      `${summarizeConfig(config)}${extruderIds ? `, extruders [${extruderIds.join(',')}]` : ''}`,
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
      offsets[i * 2] = pos
      offsets[i * 2 + 1] = stls[i].byteLength
      pos += stls[i].byteLength
    }

    const extruderIdsArr = extruderIds && extruderIds.length === stls.length ? Int32Array.from(extruderIds) : undefined

    const gcode = sliceMultiStl(orcaModule, session, combined, offsets, stls.length, configJson, extruderIdsArr)
    logInfo(
      `[OrcaWASM] slice-multi done in ${Math.round(performance.now() - startedAt)}ms ` +
        `— G-code ${(gcode.length / 1e6).toFixed(2)} MB`,
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

function doWrite3mf(stl: ArrayBuffer, config: OrcaConfig, requestId: string) {
  if (!orcaModule) return
  const startedAt = performance.now()
  logInfo(`[OrcaWASM] 3mf export start — STL ${(stl.byteLength / 1e6).toFixed(2)} MB`)
  try {
    const { _passthrough, ...rest } = config
    const engineRest = toEngineConfig(rest)
    const flat = _passthrough ? { ...engineRest, ..._passthrough } : engineRest
    const configJson = JSON.stringify(flat)
    const data = write3mf(orcaModule, session, new Uint8Array(stl), configJson)
    const dataBuffer = data.buffer as ArrayBuffer
    logInfo(
      `[OrcaWASM] 3mf export done in ${Math.round(performance.now() - startedAt)}ms ` +
        `— ${(data.byteLength / 1e6).toFixed(2)} MB`,
    )
    self.postMessage({ type: 'WRITE_3MF_COMPLETE', data: dataBuffer, requestId }, [dataBuffer])
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt)
    if (err instanceof OrcaSliceError) {
      logError(`[OrcaWASM] 3mf export failed after ${ms}ms — code ${err.code}: ${err.message}`)
      send({ type: 'WRITE_3MF_ERROR', message: err.message, requestId })
    } else {
      logError(`[OrcaWASM] 3mf export failed after ${ms}ms:`, err)
      send({ type: 'WRITE_3MF_ERROR', message: String(err), requestId })
    }
  }
}

function doRead3mf(mf: ArrayBuffer, requestId: string) {
  if (!orcaModule) return
  const startedAt = performance.now()
  logInfo(`[OrcaWASM] 3mf read start — ${(mf.byteLength / 1e6).toFixed(2)} MB`)
  try {
    const { stl, configJson } = read3mf(orcaModule, new Uint8Array(mf))
    const stlBuffer = stl.buffer as ArrayBuffer
    logInfo(
      `[OrcaWASM] 3mf read done in ${Math.round(performance.now() - startedAt)}ms ` +
        `— STL ${(stl.byteLength / 1e6).toFixed(2)} MB`,
    )
    self.postMessage({ type: 'READ_3MF_COMPLETE', stl: stlBuffer, configJson, requestId }, [stlBuffer])
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt)
    if (err instanceof OrcaSliceError) {
      logError(`[OrcaWASM] 3mf read failed after ${ms}ms — code ${err.code}: ${err.message}`)
      send({ type: 'READ_3MF_ERROR', message: err.message, requestId })
    } else {
      logError(`[OrcaWASM] 3mf read failed after ${ms}ms:`, err)
      send({ type: 'READ_3MF_ERROR', message: String(err), requestId })
    }
  }
}

function doSlice(stl: ArrayBuffer, config: OrcaConfig, extruderId?: number) {
  if (!orcaModule) return
  const startedAt = performance.now()
  logInfo(
    `[OrcaWASM] slice start — STL ${(stl.byteLength / 1e6).toFixed(2)} MB, ${summarizeConfig(config)}` +
      `${extruderId ? `, filament slot ${extruderId}` : ''}`,
  )
  try {
    const { _passthrough, ...rest } = config
    const engineRest = toEngineConfig(rest)
    const flat = _passthrough ? { ...engineRest, ..._passthrough } : engineRest
    const configJson = JSON.stringify(flat)
    // Only orc_slice_multi takes a per-object filament assignment, so an item
    // that has one goes through it as a single-object plate. orc_slice would
    // silently print it with the default filament instead — the picker would
    // appear to do nothing outside a plate slice.
    //
    // This also changes how the object is placed: orc_slice centres it
    // (center_object_xy_only), while orc_slice_multi runs arrange_objects()
    // even for a single object. So the same item can land elsewhere on the bed
    // purely because a slot was picked — expected, but it is why re-slicing
    // after an assignment differs by more than the tool changes.
    const bytes = new Uint8Array(stl)
    const gcode = extruderId
      ? sliceMultiStl(
          orcaModule,
          session,
          bytes,
          Int32Array.from([0, bytes.length]),
          1,
          configJson,
          Int32Array.from([extruderId]),
        )
      : sliceStl(orcaModule, session, bytes, configJson)
    logInfo(
      `[OrcaWASM] slice done in ${Math.round(performance.now() - startedAt)}ms ` +
        `— G-code ${(gcode.length / 1e6).toFixed(2)} MB`,
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
