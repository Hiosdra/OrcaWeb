import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { OrcaConfig, QueueItem, WorkerOutMessage } from '../types'
import { parse3mf } from '../lib/parse3mf'
import {
  getWorker,
  addWorkerListener,
  getWasmStatus,
  terminateWorker,
  type WasmStatus,
} from '../lib/worker-singleton'

export interface PlateState {
  slicing: boolean
  gcode: string | null
  error: string | null
  /** Config changed after this plate was sliced. */
  stale: boolean
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
  | { type: 'CONVERSION_DONE'; id: string; stl: ArrayBuffer }
  | { type: 'REMOVE_ITEM'; id: string }
  | { type: 'RUN_QUEUE' }
  | { type: 'QUEUE_IDLE' }
  | { type: 'SLICE_STARTED'; id: string }
  | { type: 'SLICE_DONE'; gcode: string }
  | { type: 'SLICE_FAILED'; message: string }
  | { type: 'PLATE_STARTED' }
  | { type: 'PLATE_DONE'; gcode: string }
  | { type: 'PLATE_FAILED'; message: string }
  | { type: 'CONFIG_CHANGED' }
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

function toGcodeFilename(name: string): string {
  return name.replace(/\.(stl|3mf|obj|step|stp)$/i, '') + '.gcode'
}

function patchItem(items: QueueItem[], id: string, patch: Partial<QueueItem>): QueueItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i))
}

function reducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'ADD_ITEMS':
      return { ...state, items: [...state.items, ...action.items] }

    case 'PATCH_ITEM':
      return { ...state, items: patchItem(state.items, action.id, action.patch) }

    case 'CONVERSION_DONE': {
      const item = state.items.find((i) => i.id === action.id)
      if (!item) return state // removed while converting — drop the result
      const name = item.name.replace(/\.(obj|step|stp)$/i, '.stl')
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
        sliceStartEpoch: state.configEpoch,
        items: patchItem(state.items, action.id, { status: 'slicing' }),
      }

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
            })
          : state.items,
      }
    }

    case 'SLICE_FAILED':
      if (!state.currentId) return state
      return {
        ...state,
        currentId: null,
        items: patchItem(state.items, state.currentId, { status: 'error', error: action.message }),
      }

    case 'PLATE_STARTED':
      return {
        ...state,
        plate: { slicing: true, gcode: null, error: null, stale: false },
        plateStartEpoch: state.configEpoch,
      }

    case 'PLATE_DONE':
      return {
        ...state,
        plate: {
          slicing: false,
          gcode: action.gcode,
          error: null,
          stale: state.configEpoch !== state.plateStartEpoch,
        },
      }

    case 'PLATE_FAILED':
      return { ...state, plate: { slicing: false, gcode: null, error: action.message, stale: false } }

    case 'CONFIG_CHANGED': {
      const hasResults = state.items.some((i) => i.status === 'done' && !i.stale) || state.plate.gcode
      const hasInFlight = state.currentId !== null || state.plate.slicing
      if (!hasResults && !hasInFlight) return state // nothing the epoch bump would affect
      return {
        ...state,
        configEpoch: state.configEpoch + 1,
        items: state.items.map((i) => (i.status === 'done' ? { ...i, stale: true } : i)),
        plate: state.plate.gcode ? { ...state.plate, stale: true } : state.plate,
      }
    }

    case 'CANCELLED':
      return {
        ...state,
        running: false,
        currentId: null,
        items: state.currentId
          ? patchItem(state.items, state.currentId, { status: 'ready' })
          : state.items,
        plate: state.plate.slicing ? { ...state.plate, slicing: false } : state.plate,
      }

    case 'ENGINE_FAILED':
      // The worker (and everything queued inside it) is gone — fail every
      // in-flight item instead of leaving spinners that can never resolve.
      return {
        ...state,
        running: false,
        currentId: null,
        items: state.items.map((i) =>
          i.status === 'slicing' || i.status === 'converting'
            ? { ...i, status: 'error', error: action.message }
            : i,
        ),
        plate: state.plate.slicing
          ? { slicing: false, gcode: null, error: action.message, stale: false }
          : state.plate,
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
  isSlicing: boolean
  addFiles: (files: File[]) => void
  removeItem: (id: string) => void
  /** Slice every ready item (and re-slice stale results) one after another. */
  sliceAll: () => void
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
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>(getWasmStatus)

  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  const onSettingsImportedRef = useRef(onSettingsImported)
  useEffect(() => { onSettingsImportedRef.current = onSettingsImported }, [onSettingsImported])

  // WRITE_3MF is a one-off request/response, not part of the queue state
  // machine (it doesn't change item.status) — resolved directly against the
  // promise the caller is awaiting, keyed by the same requestId the worker
  // echoes back.
  const export3mfResolvers = useRef(
    new Map<string, { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }>(),
  )

  // Mark results stale whenever the effective config changes after they were
  // produced (skip the mount run — nothing has been sliced yet).
  const configSeenRef = useRef<OrcaConfig | null>(null)
  useEffect(() => {
    if (configSeenRef.current !== null && configSeenRef.current !== config) {
      dispatch({ type: 'CONFIG_CHANGED' })
    }
    configSeenRef.current = config
  }, [config])

  // ── Worker messages → reducer ─────────────────────────────────────────────
  useEffect(() => {
    getWorker() // spawn + start loading WASM immediately

    return addWorkerListener((msg: WorkerOutMessage) => {
      switch (msg.type) {
        case 'WASM_LOADED':
          setWasmStatus('ready')
          return
        case 'WASM_ERROR':
          setWasmStatus('error')
          dispatch({ type: 'ENGINE_FAILED', message: `Slicer engine failed: ${msg.message}` })
          return
        case 'SLICE_COMPLETE':
          dispatch({ type: 'SLICE_DONE', gcode: msg.gcode })
          return
        case 'SLICE_ERROR':
          dispatch({ type: 'SLICE_FAILED', message: msg.message })
          return
        case 'SLICE_MULTI_COMPLETE':
          dispatch({ type: 'PLATE_DONE', gcode: msg.gcode })
          return
        case 'SLICE_MULTI_ERROR':
          dispatch({ type: 'PLATE_FAILED', message: msg.message })
          return
        case 'OBJ_STL_COMPLETE':
        case 'CAD_STL_COMPLETE':
          dispatch({ type: 'CONVERSION_DONE', id: msg.requestId, stl: msg.stl })
          return
        case 'OBJ_STL_ERROR':
          dispatch({ type: 'PATCH_ITEM', id: msg.requestId, patch: { status: 'error', error: `OBJ conversion failed: ${msg.message}` } })
          return
        case 'CAD_STL_ERROR':
          dispatch({ type: 'PATCH_ITEM', id: msg.requestId, patch: { status: 'error', error: `CAD conversion failed: ${msg.message}` } })
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
          const resolver = export3mfResolvers.current.get(msg.requestId)
          if (resolver) {
            export3mfResolvers.current.delete(msg.requestId)
            resolver.reject(new Error(msg.message))
          }
          return
        }
        default:
          msg satisfies never
      }
    })
  }, [])

  // ── Queue auto-advance ────────────────────────────────────────────────────
  // Single side-effect driving the engine: whenever the queue is running and
  // the engine is free, start the next ready item. Posting is safe even
  // while WASM is still loading — the worker queues the request and the
  // engine-error path fails it via ENGINE_FAILED.
  const { items, currentId, running, plate } = state
  useEffect(() => {
    if (!running || currentId || plate.slicing) return

    const next = items.find((i) => i.status === 'ready' && i.stlFile)
    if (!next) {
      // Items still converting will re-trigger this effect when they finish.
      if (!items.some((i) => i.status === 'converting')) dispatch({ type: 'QUEUE_IDLE' })
      return
    }

    dispatch({ type: 'SLICE_STARTED', id: next.id })
    void (async () => {
      try {
        const stl = await next.stlFile!.arrayBuffer()
        if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
        getWorker().postMessage({ type: 'SLICE', stl, config: configRef.current }, [stl])
      } catch {
        dispatch({ type: 'SLICE_FAILED', message: 'Failed to read file' })
      }
    })()
  }, [items, currentId, running, plate.slicing])

  // ── Actions ───────────────────────────────────────────────────────────────

  const postConversion = useCallback(async (item: QueueItem) => {
    try {
      const buf = await item.sourceFile.arrayBuffer()
      const msg = /\.obj$/i.test(item.sourceFile.name)
        ? { type: 'OBJ_TO_STL' as const, obj: buf, requestId: item.id }
        : { type: 'CAD_TO_STL' as const, cad: buf, requestId: item.id }
      if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
      getWorker().postMessage(msg, [buf])
    } catch (err) {
      dispatch({
        type: 'PATCH_ITEM',
        id: item.id,
        patch: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      })
    }
  }, [])

  const addFiles = useCallback((files: File[]) => {
    const newItems: QueueItem[] = files.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      originalSize: f.size,
      sourceFile: f,
      stlFile: null,
      status: 'converting',
    }))
    dispatch({ type: 'ADD_ITEMS', items: newItems })

    void (async () => {
      for (const item of newItems) {
        const f = item.sourceFile
        try {
          if (/\.3mf$/i.test(f.name)) {
            const buf = await f.arrayBuffer()
            const { stlBytes, config: profileConfig } = parse3mf(buf)
            if (Object.keys(profileConfig).length > 0) {
              onSettingsImportedRef.current(profileConfig, f.name)
            }
            const stlName = f.name.replace(/\.3mf$/i, '.stl')
            const stlFile = new File(
              [stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength) as ArrayBuffer],
              stlName,
              { type: 'model/stl' },
            )
            dispatch({ type: 'PATCH_ITEM', id: item.id, patch: { stlFile, name: stlName, status: 'ready' } })
          } else if (/\.(step|stp|obj)$/i.test(f.name)) {
            await postConversion(item)
          } else {
            dispatch({ type: 'PATCH_ITEM', id: item.id, patch: { stlFile: f, status: 'ready' } })
          }
        } catch (err) {
          dispatch({
            type: 'PATCH_ITEM',
            id: item.id,
            patch: { status: 'error', error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    })()
  }, [postConversion])

  // Terminating the worker also kills any conversions queued inside it —
  // re-post them (from the retained source files) to the fresh worker.
  const repostConversions = useCallback(() => {
    for (const item of state.items) {
      if (item.status === 'converting' && /\.(obj|step|stp)$/i.test(item.sourceFile.name)) {
        void postConversion(item)
      }
    }
  }, [state.items, postConversion])

  const cancel = useCallback(() => {
    if (!state.currentId && !state.plate.slicing) return
    terminateWorker()
    setWasmStatus('idle')
    dispatch({ type: 'CANCELLED' })
    repostConversions()
  }, [state.currentId, state.plate.slicing, repostConversions])

  const removeItem = useCallback((id: string) => {
    if (state.currentId === id) {
      // Removing the item being sliced: only a worker restart can abort the
      // synchronous WASM call. The queue keeps running — the next ready item
      // is posted to the fresh worker automatically.
      terminateWorker()
      setWasmStatus('idle')
      repostConversions()
    }
    dispatch({ type: 'REMOVE_ITEM', id })
  }, [state.currentId, repostConversions])

  const sliceAll = useCallback(() => {
    dispatch({ type: 'RUN_QUEUE' })
  }, [])

  // Exports one queue item's current STL + the live config as a .3mf.
  // Independent of slicing — works on any item with STL data, sliced or not.
  const export3mf = useCallback((item: QueueItem): Promise<ArrayBuffer> => {
    if (!item.stlFile) return Promise.reject(new Error('No model data for this item'))
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      export3mfResolvers.current.set(requestId, { resolve, reject })
      void (async () => {
        try {
          const stl = await item.stlFile!.arrayBuffer()
          if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
          getWorker().postMessage({ type: 'WRITE_3MF', stl, config: configRef.current, requestId }, [stl])
        } catch (err) {
          export3mfResolvers.current.delete(requestId)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })()
    })
  }, [])

  const slicePlate = useCallback(() => {
    if (state.plate.slicing) return
    const readyItems = state.items.filter((i) => i.status === 'ready' && i.stlFile != null)
    if (readyItems.length === 0) return

    dispatch({ type: 'PLATE_STARTED' })
    void (async () => {
      try {
        const stls = await Promise.all(readyItems.map((i) => i.stlFile!.arrayBuffer()))
        if (getWasmStatus() === 'idle' || getWasmStatus() === 'error') setWasmStatus('loading')
        getWorker().postMessage({ type: 'SLICE_MULTI', stls, config: configRef.current }, stls)
      } catch (err) {
        dispatch({ type: 'PLATE_FAILED', message: err instanceof Error ? err.message : String(err) })
      }
    })()
  }, [state.plate.slicing, state.items])

  return {
    items,
    plate,
    wasmStatus,
    isSlicing: currentId !== null || running,
    addFiles,
    removeItem,
    sliceAll,
    slicePlate,
    cancel,
    export3mf,
  }
}
