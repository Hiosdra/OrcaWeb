import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { logError, logWarn } from '../lib/log'
import { filamentSlotLabels, parseOrcaProfileJson } from '../lib/profiles'
import { addWorkerListener, getWasmStatus, getWorker, terminateWorker, type WasmStatus } from '../lib/worker-singleton'
import type { ConversionKind, OrcaConfig, QueueItem, SliceProgress, WorkerOutMessage } from '../types'

export interface PlateState {
  slicing: boolean
  gcode: string | null
  error: string | null
  /** Config changed after this plate was sliced. */
  stale: boolean
  progress?: SliceProgress
}

/**
 * Queue state machine. All transitions go through the reducer so every
 * decision reads the *current* queue — the previous implementation mirrored
 * the queue into a ref inside a setState updater, which left "start the next
 * slice?" checks racing against React's batching (they usually saw a stale
 * snapshot and silently did nothing).
 *
 * `configEpoch` counts config changes; a slice records the epoch it started
 * under, and a result arriving after further config edits is immediately
 * marked stale rather than presented as matching the current settings.
 */
interface QueueState {
  items: QueueItem[]
  /** Item whose SLICE request is in flight (null = engine idle for singles). */
  currentId: string | null
  /** Queue auto-advance: keep slicing ready items until none are left. */
  running: boolean
  plate: PlateState
  configEpoch: number
  sliceStartEpoch: number
  plateStartEpoch: number
}

type QueueAction =
  | { type: 'ADD_ITEMS'; items: QueueItem[] }
  | { type: 'PATCH_ITEM'; id: string; patch: Partial<QueueItem> }
  | { type: 'ASSIGN_EXTRUDER'; id: string; extruderId?: number }
  | { type: 'CONVERSION_DONE'; id: string; stl: ArrayBuffer }
  | { type: 'REMOVE_ITEM'; id: string }
  | { type: 'RUN_QUEUE' }
  | { type: 'QUEUE_IDLE' }
  | { type: 'SLICE_STARTED'; id: string; configEpoch: number }
  | { type: 'SLICE_PROGRESS'; progress: SliceProgress }
  | { type: 'SLICE_DONE'; gcode: string }
  | { type: 'SLICE_FAILED'; message: string }
  | { type: 'PLATE_STARTED'; configEpoch: number }
  | { type: 'PLATE_DONE'; gcode: string }
  | { type: 'PLATE_FAILED'; message: string }
  // slotCount: how many filament slots the new config has, so assignments
  // naming a slot it no longer has can be dropped (see the reducer).
  | { type: 'CONFIG_CHANGED'; epoch: number; slotCount: number }
  | { type: 'CANCELLED' }
  | { type: 'ENGINE_FAILED'; message: string }

const INITIAL_PLATE: PlateState = { slicing: false, gcode: null, error: null, stale: false }

const INITIAL_STATE: QueueState = {
  items: [],
  currentId: null,
  running: false,
  plate: INITIAL_PLATE,
  configEpoch: 0,
  sliceStartEpoch: 0,
  plateStartEpoch: 0,
}

class ItemRemovedError extends Error {}

/**
 * The single place a filename decides which engine conversion an upload
 * needs. Recorded on the QueueItem at creation (see QueueItem.conversion) so
 * every later consumer — the initial post, and the re-post after a worker
 * restart — reads the same answer instead of re-deriving it from the name.
 * `undefined` means the file is already an STL and needs no conversion.
 */
function classifyConversion(filename: string): ConversionKind | undefined {
  if (/\.3mf$/i.test(filename)) return '3mf'
  if (/\.obj$/i.test(filename)) return 'obj'
  if (/\.(step|stp)$/i.test(filename)) return 'cad'
  return undefined
}

/**
 * Build the per-object `extruderIds` array for a plate slice from the ready
 * items' filament-slot assignments (parallel to `items`). Returns undefined
 * when no object is assigned a slot, so a single-material plate omits the
 * field entirely and hits the exact same orc_slice_multi path as before an
 * assignment ever existed. Unassigned objects on an otherwise-assigned plate
 * are sent as 0 (inherit the config's default extruder). Exported for tests.
 */
export function buildPlateExtruderIds(items: Pick<QueueItem, 'extruderId'>[]): number[] | undefined {
  const ids = items.map((i) => i.extruderId ?? 0)
  return ids.some((id) => id > 0) ? ids : undefined
}

function toGcodeFilename(name: string): string {
  return `${name.replace(/\.(stl|3mf|obj|step|stp)$/i, '')}.gcode`
}

function patchItem(items: QueueItem[], id: string, patch: Partial<QueueItem>): QueueItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i))
}

export function sliceQueueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'ADD_ITEMS':
      return { ...state, items: [...state.items, ...action.items] }

    case 'PATCH_ITEM':
      return { ...state, items: patchItem(state.items, action.id, action.patch) }

    case 'ASSIGN_EXTRUDER': {
      // Picking a different filament changes what this object would print
      // with, so any G-code already produced for it no longer matches — mark
      // it stale exactly like CONFIG_CHANGED does for a settings edit, so the
      // Slice button offers to re-run it. Both slice paths honour the
      // assignment (the single one via a one-object plate), so re-slicing
      // genuinely produces different output rather than the same bytes.
      const item = state.items.find((i) => i.id === action.id)
      const wasSliced = item?.status === 'done'
      return {
        ...state,
        items: patchItem(state.items, action.id, {
          extruderId: action.extruderId,
          ...(wasSliced ? { stale: true } : {}),
        }),
        // The plate mixes every object, so it goes stale on any reassignment.
        plate: state.plate.gcode ? { ...state.plate, stale: true } : state.plate,
      }
    }

    case 'CONVERSION_DONE': {
      const item = state.items.find((i) => i.id === action.id)
      if (!item) return state // removed while converting — drop the result
      const name = item.name.replace(/\.(obj|step|stp|3mf)$/i, '.stl')
      const stlFile = new File([action.stl], name, { type: 'model/stl' })
      return { ...state, items: patchItem(state.items, action.id, { stlFile, name, status: 'ready' }) }
    }

    case 'REMOVE_ITEM':
      return {
        ...state,
        items: state.items.filter((i) => i.id !== action.id),
        currentId: state.currentId === action.id ? null : state.currentId,
      }

    case 'RUN_QUEUE':
      if (state.plate.slicing) return state
      // Re-queue stale results alongside never-sliced items.
      return {
        ...state,
        running: true,
        items: state.items.map((i) =>
          i.status === 'done' && i.stale
            ? { ...i, status: 'ready', gcode: undefined, gcodeFilename: undefined, stale: undefined }
            : i,
        ),
      }

    case 'QUEUE_IDLE':
      return state.running ? { ...state, running: false } : state

    case 'SLICE_STARTED':
      return {
        ...state,
        currentId: action.id,
        sliceStartEpoch: action.configEpoch,
        items: patchItem(state.items, action.id, { status: 'slicing', progress: undefined }),
      }

    case 'SLICE_PROGRESS':
      if (state.currentId) {
        return {
          ...state,
          items: patchItem(state.items, state.currentId, { progress: action.progress }),
        }
      }
      return state.plate.slicing ? { ...state, plate: { ...state.plate, progress: action.progress } } : state

    case 'SLICE_DONE': {
      if (!state.currentId) return state // cancelled while the result was in transit
      const item = state.items.find((i) => i.id === state.currentId)
      return {
        ...state,
        currentId: null,
        items: item
          ? patchItem(state.items, state.currentId, {
              status: 'done',
              gcode: action.gcode,
              gcodeFilename: toGcodeFilename(item.name),
              stale: state.configEpoch !== state.sliceStartEpoch || undefined,
              progress: undefined,
            })
          : state.items,
      }
    }

    case 'SLICE_FAILED':
      if (!state.currentId) return state
      return {
        ...state,
        currentId: null,
        items: patchItem(state.items, state.currentId, { status: 'error', error: action.message, progress: undefined }),
      }

    case 'PLATE_STARTED':
      if (state.currentId !== null || state.running || state.plate.slicing) return state
      return {
        ...state,
        plate: { slicing: true, gcode: null, error: null, stale: false, progress: undefined },
        plateStartEpoch: action.configEpoch,
      }

    case 'PLATE_DONE':
      return {
        ...state,
        plate: {
          slicing: false,
          gcode: action.gcode,
          error: null,
          stale: state.configEpoch !== state.plateStartEpoch,
          progress: undefined,
        },
      }

    case 'PLATE_FAILED':
      return {
        ...state,
        plate: { slicing: false, gcode: null, error: action.message, stale: false, progress: undefined },
      }

    case 'CONFIG_CHANGED': {
      // Removing a filament slot leaves assignments pointing at a slot that no
      // longer exists. Nothing in the UI shows them any more — the picker
      // disappears entirely below two slots — but buildPlateExtruderIds would
      // still send them, and the engine would index its per-filament vectors
      // by an out-of-range filament id. Drop them here, where the slot count
      // can actually change.
      //
      // A config back down to one slot drops *every* assignment, not just the
      // out-of-range ones: "slot 1" of one slot is what the config already
      // does, and keeping it would leave the plate on the assigned code path
      // (a non-empty extruderIds array) with no picker to clear it from.
      const staleSlot = (id: number | undefined) => id !== undefined && (action.slotCount < 2 || id > action.slotCount)
      const dropStaleSlot = (i: QueueItem): QueueItem => (staleSlot(i.extruderId) ? { ...i, extruderId: undefined } : i)
      return {
        ...state,
        configEpoch: action.epoch,
        items: state.items.map((i) => dropStaleSlot(i.status === 'done' ? { ...i, stale: true } : i)),
        plate: state.plate.gcode ? { ...state.plate, stale: true } : state.plate,
      }
    }

    case 'CANCELLED':
      return {
        ...state,
        running: false,
        currentId: null,
        items: state.currentId
          ? patchItem(state.items, state.currentId, { status: 'ready', progress: undefined })
          : state.items,
        plate: state.plate.slicing ? { ...state.plate, slicing: false, progress: undefined } : state.plate,
      }

    case 'ENGINE_FAILED':
      // The worker (and everything queued inside it) is gone — fail every
      // in-flight item instead of leaving spinners that can never resolve.
      return {
        ...state,
        running: false,
        currentId: null,
        items: state.items.map((i) =>
          i.status === 'slicing' || i.status === 'converting' ? { ...i, status: 'error', error: action.message } : i,
        ),
        plate: state.plate.slicing ? { slicing: false, gcode: null, error: action.message, stale: false } : state.plate,
      }

    default:
      action satisfies never
      return state
  }
}

export interface SliceQueue {
  items: QueueItem[]
  plate: PlateState
  wasmStatus: WasmStatus
  /** Human-readable engine version for the header — the build-time baked
   *  value until the worker resolves the live one from engine-version.json. */
  engineLabel: string
  isSlicing: boolean
  addFiles: (files: File[]) => void
  removeItem: (id: string) => void
  /** Slice every ready item (and re-slice stale results) one after another. */
  sliceAll: () => void
  /** Assign an item to a 1-based filament/extruder slot for plate slicing
   *  (0 = inherit the config default). No-op for single slicing. */
  assignExtruder: (id: string, extruderId: number) => void
  /** Arrange all ready items on one plate and slice them together. */
  slicePlate: () => void
  /** Abort the running slice — terminates the worker and restarts the engine. */
  cancel: () => void
  /** Export one item's current model + live config as a .3mf (no plate/gcode data). */
  export3mf: (item: QueueItem) => Promise<ArrayBuffer>
}

export function useSliceQueue(
  config: OrcaConfig,
  /** Called when an imported file (3MF) carries embedded print settings. */
  onSettingsImported: (patch: Partial<OrcaConfig>, filename: string) => void,
): SliceQueue {
  const [state, dispatch] = useReducer(sliceQueueReducer, INITIAL_STATE)
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>(getWasmStatus)
  // Starts as the build-time baked label; replaced by the runtime-resolved
  // one the worker sends with WASM_LOADED (from engine-version.json).
  const [engineLabel, setEngineLabel] = useState<string>(__ORCA_ENGINE_VERSION__)

  const configSnapshotRef = useRef({ config, epoch: 0 })

  // A file read can outlive cancellation or a worker restart. Incrementing
  // this generation invalidates the eventual postMessage from that read.
  const sliceRequestGeneration = useRef(0)

  // Item IDs captured by the currently in-flight (preparing or slicing)
  // "One plate" request — lets removeItem() tell whether the item it's
  // removing actually needs to abort that plate slice, instead of either
  // ignoring the removal (the item quietly survives into the resulting
  // G-code — the WASM call is synchronous, so once posted nothing short of
  // a worker restart can pull one object back out) or nuking every plate
  // slice on any unrelated removal. Set at the start of slicePlate() (before
  // its async STL-read gap) and cleared once that request truly concludes.
  const platePreparedIdsRef = useRef<Set<string> | null>(null)

  const onSettingsImportedRef = useRef(onSettingsImported)
  useEffect(() => {
    onSettingsImportedRef.current = onSettingsImported
  }, [onSettingsImported])

  // WRITE_3MF / READ_3MF are one-off request/response round trips, not part
  // of the queue state machine — resolved directly against the promise the
  // caller is awaiting, keyed by the same requestId the worker echoes back.
  // itemId is carried alongside so a removed item's own pending requests can
  // be found and rejected without disturbing other items' in-flight ones.
  const export3mfResolvers = useRef(
    new Map<string, { itemId: string; resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }>(),
  )
  const read3mfResolvers = useRef(
    new Map<
      string,
      {
        itemId: string
        resolve: (data: { stl: ArrayBuffer; configJson: string }) => void
        reject: (err: Error) => void
      }
    >(),
  )

  // Terminating the worker (cancel/removeItem) or a WASM_ERROR both orphan
  // any in-flight WRITE_3MF/READ_3MF requests — nothing will ever answer
  // them, so without this every pending export3mf()/engine 3MF-read promise
  // would hang forever (export3mf: the "Exporting…" button stuck; read: the
  // queue item stuck on "Converting…" instead of falling back to the JS parser).
  const rejectAllPendingMf = useCallback((message: string) => {
    for (const resolvers of [export3mfResolvers.current, read3mfResolvers.current]) {
      if (resolvers.size === 0) continue
      const pending = [...resolvers.values()]
      resolvers.clear()
      for (const { reject } of pending) reject(new Error(message))
    }
  }, [])

  // Removing an item should orphan only THAT item's pending export/read
  // requests, not every in-flight request — unlike rejectAllPendingMf, which
  // is for "the whole engine died" (cancel / WASM_ERROR).
  const rejectPendingForItem = useCallback((itemId: string, message: string) => {
    for (const resolvers of [export3mfResolvers.current, read3mfResolvers.current]) {
      for (const [requestId, entry] of resolvers) {
        if (entry.itemId !== itemId) continue
        resolvers.delete(requestId)
        entry.reject(new ItemRemovedError(message))
      }
    }
  }, [])

  // Keep config and epoch as one snapshot so a delayed file read cannot send
  // a newer config than the epoch recorded for its slice request.
  useEffect(() => {
    if (configSnapshotRef.current.config === config) return
    const snapshot = {
      config,
      epoch: configSnapshotRef.current.epoch + 1,
    }
    configSnapshotRef.current = snapshot
    dispatch({ type: 'CONFIG_CHANGED', epoch: snapshot.epoch, slotCount: filamentSlotLabels(config).length })
  }, [config])

  // ── Worker messages → reducer ─────────────────────────────────────────────
  useEffect(() => {
    getWorker() // spawn + start loading WASM immediately

    return addWorkerListener((msg: WorkerOutMessage) => {
      switch (msg.type) {
        case 'WASM_LOADED':
          setWasmStatus('ready')
          if (msg.engineLabel) setEngineLabel(msg.engineLabel)
          return
        case 'WASM_ERROR':
          logError('[queue] engine reported WASM_ERROR — failing every in-flight item:', msg.message)
          setWasmStatus('error')
          dispatch({ type: 'ENGINE_FAILED', message: `Slicer engine failed: ${msg.message}` })
          rejectAllPendingMf(`Slicer engine failed: ${msg.message}`)
          platePreparedIdsRef.current = null
          return
        case 'SLICE_PROGRESS':
          dispatch({ type: 'SLICE_PROGRESS', progress: { percent: msg.percent, stage: msg.stage } })
          return
        case 'SLICE_COMPLETE':
          dispatch({ type: 'SLICE_DONE', gcode: msg.gcode })
          return
        case 'SLICE_ERROR':
          logError('[queue] SLICE_ERROR:', msg.message)
          dispatch({ type: 'SLICE_FAILED', message: msg.message })
          return
        case 'SLICE_MULTI_COMPLETE':
          dispatch({ type: 'PLATE_DONE', gcode: msg.gcode })
          platePreparedIdsRef.current = null
          return
        case 'SLICE_MULTI_ERROR':
          logError('[queue] SLICE_MULTI_ERROR (plate):', msg.message)
          dispatch({ type: 'PLATE_FAILED', message: msg.message })
          platePreparedIdsRef.current = null
          return
        case 'OBJ_STL_COMPLETE':
        case 'CAD_STL_COMPLETE':
          dispatch({ type: 'CONVERSION_DONE', id: msg.requestId, stl: msg.stl })
          return
        case 'OBJ_STL_ERROR':
          logError(`[queue] OBJ_STL_ERROR for item ${msg.requestId}:`, msg.message)
          dispatch({
            type: 'PATCH_ITEM',
            id: msg.requestId,
            patch: { status: 'error', error: `OBJ conversion failed: ${msg.message}` },
          })
          return
        case 'CAD_STL_ERROR':
          logError(`[queue] CAD_STL_ERROR for item ${msg.requestId}:`, msg.message)
          dispatch({
            type: 'PATCH_ITEM',
            id: msg.requestId,
            patch: { status: 'error', error: `CAD conversion failed: ${msg.message}` },
          })
          return
        case 'WRITE_3MF_COMPLETE': {
          const resolver = export3mfResolvers.current.get(msg.requestId)
          if (resolver) {
            export3mfResolvers.current.delete(msg.requestId)
            resolver.resolve(msg.data)
          }
          return
        }
        case 'WRITE_3MF_ERROR': {
          logError(`[queue] WRITE_3MF_ERROR for request ${msg.requestId}:`, msg.message)
          const resolver = export3mfResolvers.current.get(msg.requestId)
          if (resolver) {
            export3mfResolvers.current.delete(msg.requestId)
            resolver.reject(new Error(msg.message))
          }
          return
        }
        case 'READ_3MF_COMPLETE': {
          const resolver = read3mfResolvers.current.get(msg.requestId)
          if (resolver) {
            read3mfResolvers.current.delete(msg.requestId)
            resolver.resolve({ stl: msg.stl, configJson: msg.configJson })
          }
          return
        }
        case 'READ_3MF_ERROR': {
          logError(`[queue] READ_3MF_ERROR for request ${msg.requestId}:`, msg.message)
          const resolver = read3mfResolvers.current.get(msg.requestId)
          if (resolver) {
            read3mfResolvers.current.delete(msg.requestId)
            resolver.reject(new Error(msg.message))
          }
          return
        }
        default:
          msg satisfies never
      }
    })
    // rejectAllPendingMf is a useCallback with an empty dependency list, so
    // its reference is stable for the hook's lifetime — listing it keeps the
    // linter honest without ever re-registering the worker listener.
  }, [rejectAllPendingMf])

  // ── Queue auto-advance ────────────────────────────────────────────────────
  // Single side-effect driving the engine: whenever the queue is running and
  // the engine is free, start the next ready item. Posting is safe even
  // while WASM is still loading — the worker queues the request and the
  // engine-error path fails it via ENGINE_FAILED.
  const { items, currentId, running, plate } = state
  useEffect(() => {
    if (!running || currentId || plate.slicing) return

    // Narrowed via the predicate so `next.stlFile` stays non-null inside the
    // async closure below, where a property narrowing wouldn't survive.
    const next = items.find((i): i is QueueItem & { stlFile: File } => i.status === 'ready' && i.stlFile != null)
    if (!next) {
      // Items still converting will re-trigger this effect when they finish.
      if (!items.some((i) => i.status === 'converting')) dispatch({ type: 'QUEUE_IDLE' })
      return
    }

    const configSnapshot = configSnapshotRef.current
    dispatch({ type: 'SLICE_STARTED', id: next.id, configEpoch: configSnapshot.epoch })
    const requestGeneration = sliceRequestGeneration.current
    void (async () => {
      try {
        const stl = await next.stlFile.arrayBuffer()
        if (requestGeneration !== sliceRequestGeneration.current) return
        if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
        getWorker().postMessage(
          {
            type: 'SLICE',
            stl,
            config: configSnapshot.config,
            ...(next.extruderId ? { extruderId: next.extruderId } : {}),
          },
          [stl],
        )
      } catch (err) {
        if (requestGeneration !== sliceRequestGeneration.current) return
        logError(`[queue] failed to read "${next.name}" for slicing:`, err)
        dispatch({ type: 'SLICE_FAILED', message: 'Failed to read file' })
      }
    })()
  }, [items, currentId, running, plate.slicing])

  // ── Actions ───────────────────────────────────────────────────────────────

  const postConversion = useCallback(async (item: QueueItem) => {
    try {
      const buf = await item.sourceFile.arrayBuffer()
      const msg =
        item.conversion === 'obj'
          ? { type: 'OBJ_TO_STL' as const, obj: buf, requestId: item.id }
          : { type: 'CAD_TO_STL' as const, cad: buf, requestId: item.id }
      if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
      getWorker().postMessage(msg, [buf])
    } catch (err) {
      logError(`[queue] failed to start conversion for "${item.name}":`, err)
      dispatch({
        type: 'PATCH_ITEM',
        id: item.id,
        patch: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      })
    }
  }, [])

  // Reads a .3mf via the WASM engine's own reader (orc_read_3mf) — see that
  // bridge function's doc comment for why a real OrcaSlicer reader is used
  // instead of re-deriving the 3MF spec's transform math in JS (Orca-specific
  // transform/assembly handling). `mf` is transferred to the worker
  // (detached here), so callers must not reuse it afterwards. `itemId` lets
  // removeItem() find and cancel this specific request later.
  const readMf3ViaEngine = useCallback(
    (mf: ArrayBuffer, itemId: string): Promise<{ stl: ArrayBuffer; configJson: string }> => {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID()
        read3mfResolvers.current.set(requestId, { itemId, resolve, reject })
        try {
          if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
          getWorker().postMessage({ type: 'READ_3MF', mf, requestId }, [mf])
        } catch (err) {
          logError(`[queue] failed to post READ_3MF for item ${itemId}:`, err)
          read3mfResolvers.current.delete(requestId)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    [],
  )

  // Reads a .3mf via the engine. Deliberately NOT awaited by addFiles's
  // batch loop (see there) — it handles its own success/error dispatch
  // end-to-end, the same shape as postConversion(), just for 3MF instead
  // of OBJ/STEP.
  const importMf3 = useCallback(
    async (item: QueueItem) => {
      const f = item.sourceFile
      try {
        const buf = await f.arrayBuffer()
        const { stl, configJson } = await readMf3ViaEngine(buf, item.id)
        const profileConfig = parseOrcaProfileJson(configJson)
        if (Object.keys(profileConfig).length > 0) {
          onSettingsImportedRef.current(profileConfig, f.name)
        }
        dispatch({ type: 'CONVERSION_DONE', id: item.id, stl })
      } catch (err) {
        // Removal is cancellation, not an engine-read failure.
        if (err instanceof ItemRemovedError) return
        logError(`[queue] 3MF import failed for "${f.name}":`, err)
        dispatch({
          type: 'PATCH_ITEM',
          id: item.id,
          patch: { status: 'error', error: err instanceof Error ? err.message : String(err) },
        })
      }
    },
    [readMf3ViaEngine],
  )

  const addFiles = useCallback(
    (files: File[]) => {
      const newItems: QueueItem[] = files.map((f) => {
        const conversion = classifyConversion(f.name)
        return {
          id: crypto.randomUUID(),
          name: f.name,
          originalSize: f.size,
          sourceFile: f,
          stlFile: null,
          // Stays 'converting' even for a plain STL: the loop below flips it
          // to 'ready' together with stlFile in one patch, and no consumer
          // should ever see 'ready' with a null stlFile.
          status: 'converting',
          conversion,
        }
      })
      dispatch({ type: 'ADD_ITEMS', items: newItems })

      void (async () => {
        for (const item of newItems) {
          const f = item.sourceFile
          try {
            if (item.conversion === '3mf') {
              // Fire-and-forget, like the OBJ/STEP branch below — importMf3
              // resolves its own success/fallback/error internally, so one
              // slow (or WASM-load-blocked) .3mf doesn't hold up every other
              // file dropped in the same batch behind it in this loop.
              void importMf3(item)
            } else if (item.conversion) {
              await postConversion(item)
            } else {
              dispatch({ type: 'PATCH_ITEM', id: item.id, patch: { stlFile: f, status: 'ready' } })
            }
          } catch (err) {
            logError(`[queue] failed to process "${f.name}":`, err)
            dispatch({
              type: 'PATCH_ITEM',
              id: item.id,
              patch: { status: 'error', error: err instanceof Error ? err.message : String(err) },
            })
          }
        }
      })()
    },
    [postConversion, importMf3],
  )

  // Terminating the worker also kills any conversions queued inside it —
  // re-post them (from the retained source files) to the fresh worker. This
  // includes in-flight .3mf reads (READ_3MF), not just OBJ/STEP: without the
  // 3mf branch, an unrelated .3mf import running when the user cancels a
  // *different* item's slice (or removes the item currently slicing) would
  // get caught by the blanket rejectAllPendingMf() that follows and flip to
  // a permanent error — even though nothing about that import itself failed.
  //
  // Split into two phases, and it has to stay that way. Discarding the stale
  // request must happen *before* the caller's rejectAllPendingMf() (it uses
  // ItemRemovedError, which importMf3()'s catch treats as a silent no-op,
  // whereas rejectAllPendingMf's plain Error would dispatch a spurious item
  // error); posting the replacement must happen *after* it, or that blanket
  // reject cancels the retry it was never meant to see. Returning the second
  // phase as a thunk makes both orderings structural. Previously this posted
  // immediately and survived only because importMf3() happens to await
  // arrayBuffer() before registering its resolver — correct, but silently
  // broken by anyone hoisting that registration.
  const prepareConversionReposts = useCallback((): (() => void) => {
    const reposts: (() => void)[] = []
    for (const item of state.items) {
      if (item.status !== 'converting') continue
      switch (item.conversion) {
        case 'obj':
        case 'cad':
          // No resolver of its own — the engine replies by requestId, so
          // there is nothing stale to discard first.
          reposts.push(() => void postConversion(item))
          break
        case '3mf':
          rejectPendingForItem(item.id, 'Engine restarted — retrying import')
          reposts.push(() => void importMf3(item))
          break
        default:
          // No conversion request was ever posted for this item (it was
          // already an STL), so there's nothing to re-post. Exhaustive by
          // construction: a new ConversionKind fails to compile here.
          item.conversion satisfies undefined
      }
    }
    return () => {
      for (const repost of reposts) repost()
    }
  }, [state.items, postConversion, importMf3, rejectPendingForItem])

  const cancel = useCallback(() => {
    if (!state.currentId && !state.plate.slicing) return
    logWarn(
      `[queue] cancel requested (currentId=${state.currentId ?? 'none'}, plate.slicing=${state.plate.slicing}) — restarting engine`,
    )
    sliceRequestGeneration.current += 1
    terminateWorker()
    setWasmStatus('idle')
    dispatch({ type: 'CANCELLED' })
    const postReplacements = prepareConversionReposts()
    rejectAllPendingMf('Slice cancelled — engine restarted')
    postReplacements()
    platePreparedIdsRef.current = null
  }, [state.currentId, state.plate.slicing, prepareConversionReposts, rejectAllPendingMf])

  const removeItem = useCallback(
    (id: string) => {
      // Whether `id` is actually part of the plate request currently being
      // prepared/sliced — not just "is *any* plate slice running" (that
      // would abort an unrelated plate slice over an item that was never
      // part of it, e.g. one added afterward).
      const isPlateTarget = platePreparedIdsRef.current?.has(id) ?? false
      if (state.currentId === id || isPlateTarget) {
        // Removing the item being sliced: only a worker restart can abort the
        // synchronous WASM call. For the single-item case the queue keeps
        // running — the next ready item is posted to the fresh worker
        // automatically. For the plate case there's no "next item" to fall
        // back to (arrangement covers the whole set), so the CANCELLED
        // dispatch below also resets plate.slicing — same as the explicit
        // Cancel button — rather than leaving the UI stuck on "Slicing
        // plate…" waiting for a response the terminated worker will never send.
        logWarn(`[queue] removing in-flight item ${id} — restarting engine to abort its slice`)
        sliceRequestGeneration.current += 1
        terminateWorker()
        setWasmStatus('idle')
        const postReplacements = prepareConversionReposts()
        rejectAllPendingMf('Engine restarted — export cancelled')
        postReplacements()
        if (isPlateTarget) {
          platePreparedIdsRef.current = null
          dispatch({ type: 'CANCELLED' })
        }
      }
      // Independent of the above: this item may have its own in-flight
      // export3mf()/engine 3MF-read request (keyed by a UUID unrelated to
      // currentId) that would otherwise still resolve after removal — e.g.
      // silently downloading a .3mf for an item the user just deleted.
      rejectPendingForItem(id, 'Item removed from queue')
      dispatch({ type: 'REMOVE_ITEM', id })
    },
    [state.currentId, prepareConversionReposts, rejectAllPendingMf, rejectPendingForItem],
  )

  const sliceAll = useCallback(() => {
    if (state.plate.slicing) return
    dispatch({ type: 'RUN_QUEUE' })
  }, [state.plate.slicing])

  const assignExtruder = useCallback((id: string, extruderId: number) => {
    // Store 0 as undefined so it round-trips cleanly and the plate slice below
    // only builds an extruderIds array when at least one object is assigned.
    dispatch({ type: 'ASSIGN_EXTRUDER', id, extruderId: extruderId > 0 ? extruderId : undefined })
  }, [])

  // Exports one queue item's current STL + config snapshot as a .3mf.
  // Independent of slicing — works on any item with STL data, sliced or not.
  const export3mf = useCallback((item: QueueItem): Promise<ArrayBuffer> => {
    // Bound to a local so the guard still holds inside the async closure.
    const stlFile = item.stlFile
    if (!stlFile) return Promise.reject(new Error('No model data for this item'))
    const configSnapshot = configSnapshotRef.current
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      export3mfResolvers.current.set(requestId, { itemId: item.id, resolve, reject })
      void (async () => {
        try {
          const stl = await stlFile.arrayBuffer()
          if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
          getWorker().postMessage({ type: 'WRITE_3MF', stl, config: configSnapshot.config, requestId }, [stl])
        } catch (err) {
          logError(`[queue] failed to post WRITE_3MF for "${item.name}":`, err)
          export3mfResolvers.current.delete(requestId)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })()
    })
  }, [])

  const slicePlate = useCallback(() => {
    if (state.plate.slicing || state.currentId !== null || state.running) return
    const readyItems = state.items.filter(
      (i): i is QueueItem & { stlFile: File } => i.status === 'ready' && i.stlFile != null,
    )
    if (readyItems.length === 0) return

    const configSnapshot = configSnapshotRef.current
    // Per-object filament/extruder-slot assignment, parallel to readyItems;
    // undefined (omitted from the message) when nothing is assigned.
    const extruderIds = buildPlateExtruderIds(readyItems)
    dispatch({ type: 'PLATE_STARTED', configEpoch: configSnapshot.epoch })
    const requestGeneration = sliceRequestGeneration.current
    // Recorded synchronously (before the STL-read await below) so a
    // removeItem() call racing this request can tell whether the item it's
    // removing is actually part of it — see platePreparedIdsRef's own comment.
    platePreparedIdsRef.current = new Set(readyItems.map((i) => i.id))
    void (async () => {
      try {
        const stls = await Promise.all(readyItems.map((i) => i.stlFile.arrayBuffer()))
        if (requestGeneration !== sliceRequestGeneration.current) return
        if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
        getWorker().postMessage(
          { type: 'SLICE_MULTI', stls, config: configSnapshot.config, ...(extruderIds ? { extruderIds } : {}) },
          stls,
        )
      } catch (err) {
        if (requestGeneration !== sliceRequestGeneration.current) return
        logError('[queue] failed to prepare plate slice:', err)
        dispatch({ type: 'PLATE_FAILED', message: err instanceof Error ? err.message : String(err) })
        // Otherwise this request's ids linger in platePreparedIdsRef forever
        // (PLATE_DONE/SLICE_MULTI_ERROR/WASM_ERROR/cancel all clear it, but
        // this early-failure path — e.g. a queued item's file changed on
        // disk and arrayBuffer() rejects — didn't). A later removeItem() for
        // any of those now-stale ids would then wrongly think it's aborting
        // a live plate slice and restart the engine over nothing.
        platePreparedIdsRef.current = null
      }
    })()
  }, [state.plate.slicing, state.currentId, state.running, state.items])

  return {
    items,
    plate,
    wasmStatus,
    engineLabel,
    isSlicing: currentId !== null || running,
    addFiles,
    removeItem,
    sliceAll,
    assignExtruder,
    slicePlate,
    cancel,
    export3mf,
  }
}
