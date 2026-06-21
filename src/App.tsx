import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import clsx from 'clsx'
import { FileUpload } from './components/FileUpload'
import { ModelViewer } from './components/ModelViewer'
import { SettingsPanel } from './components/SettingsPanel'
import { GcodeViewer } from './components/GcodeViewer'
import type { OrcaConfig, WorkerOutMessage } from './types'
import { buildConfig } from './lib/profiles'
import { parse3mf } from './lib/parse3mf'
import { cadToStl } from './lib/step-converter'
import { formatBytes } from './lib/format'
import {
  getWorker,
  addWorkerListener,
  getWasmStatus,
  getWasmError,
  type WasmStatus,
} from './lib/worker-singleton'

// ── Queue item ────────────────────────────────────────────────────────────────

type ItemStatus = 'converting' | 'ready' | 'slicing' | 'done' | 'error'

interface QueueItem {
  id: string
  name: string
  originalSize: number
  stlFile: File | null
  status: ItemStatus
  gcode?: string
  gcodeFilename?: string
  error?: string
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = 'upload' | 'settings' | 'slice'

const TABS: { id: Tab; label: string }[] = [
  { id: 'upload', label: 'Model' },
  { id: 'settings', label: 'Settings' },
  { id: 'slice', label: 'Slice' },
]

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [activeTab, setActiveTab] = useState<Tab>('upload')

  const [selectedPreset, setSelectedPreset] = useState('standard')
  const [selectedPrinter, setSelectedPrinter] = useState('Generic 0.4')
  const [selectedFilament, setSelectedFilament] = useState('PLA')
  const [configOverrides, setConfigOverrides] = useState<Partial<OrcaConfig>>({})
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>(getWasmStatus)
  const [plateGcode, setPlateGcode] = useState<string | null>(null)
  const [isSlicingPlate, setIsSlicingPlate] = useState(false)
  const [plateError, setPlateError] = useState<string | null>(null)

  // Refs — stable across renders, used inside effect closures
  const queueRef = useRef<QueueItem[]>([])
  const currentItemIdRef = useRef<string | null>(null)
  const configRef = useRef<OrcaConfig | null>(null)
  const wasmStatusRef = useRef<WasmStatus>(getWasmStatus())
  const pendingFirstSliceRef = useRef<{ id: string; stl: ArrayBuffer; config: OrcaConfig } | null>(null)
  const pendingObjConversionsRef = useRef(new Map<string, string>())

  const baseConfig = useMemo(
    () => buildConfig(selectedPrinter, selectedFilament, selectedPreset),
    [selectedPrinter, selectedFilament, selectedPreset],
  )
  const config: OrcaConfig = useMemo(
    () => ({ ...baseConfig, ...configOverrides }),
    [baseConfig, configOverrides],
  )

  useEffect(() => { configRef.current = config }, [config])
  useEffect(() => { wasmStatusRef.current = wasmStatus }, [wasmStatus])

  const bedX = config.bed_size_x ?? 256
  const bedY = config.bed_size_y ?? 256
  const bedShape = config.bed_shape ?? 'rectangle'

  // Keep queueRef in sync and return next state (used inside effects/closures)
  const updateQueue = useCallback((updater: (q: QueueItem[]) => QueueItem[]) => {
    setQueue(prev => {
      const next = updater(prev)
      queueRef.current = next
      return next
    })
  }, [])

  // ── Slicing ──────────────────────────────────────────────────────────────────

  const startNextSlice = useCallback(async () => {
    const next = queueRef.current.find(i => i.status === 'ready')
    if (!next || !next.stlFile) return

    currentItemIdRef.current = next.id
    updateQueue(q => q.map(i => i.id === next.id ? { ...i, status: 'slicing' } : i))

    let stlBuffer: ArrayBuffer
    try {
      stlBuffer = await next.stlFile.arrayBuffer()
    } catch {
      updateQueue(q => q.map(i => i.id === next.id ? { ...i, status: 'error', error: 'Failed to read file' } : i))
      currentItemIdRef.current = null
      return
    }

    const cfg = configRef.current!
    if (wasmStatusRef.current === 'ready') {
      getWorker().postMessage({ type: 'SLICE', stl: stlBuffer, config: cfg }, [stlBuffer])
    } else if (wasmStatusRef.current === 'loading') {
      pendingFirstSliceRef.current = { id: next.id, stl: stlBuffer, config: cfg }
      // Worker will fire WASM_LOADED; the listener sends the pending slice then
    } else {
      updateQueue(q => q.map(i => i.id === next.id ? { ...i, status: 'error', error: `Slicer engine failed to load: ${getWasmError()}` } : i))
      currentItemIdRef.current = null
    }
  }, [updateQueue])

  // ── Worker listener ───────────────────────────────────────────────────────────

  useEffect(() => {
    getWorker()

    const remove = addWorkerListener((msg: WorkerOutMessage) => {
      if (msg.type === 'WASM_LOADED') {
        setWasmStatus('ready')
        wasmStatusRef.current = 'ready'
        const pending = pendingFirstSliceRef.current
        if (pending) {
          pendingFirstSliceRef.current = null
          getWorker().postMessage({ type: 'SLICE', stl: pending.stl, config: pending.config }, [pending.stl])
        }
        return
      }

      if (msg.type === 'WASM_ERROR') {
        setWasmStatus('error')
        wasmStatusRef.current = 'error'
        const pending = pendingFirstSliceRef.current
        if (pending) {
          pendingFirstSliceRef.current = null
          updateQueue(q => q.map(i => i.id === pending.id ? { ...i, status: 'error', error: `Engine failed to load: ${msg.message}` } : i))
          currentItemIdRef.current = null
        }
        return
      }

      if (msg.type === 'SLICE_COMPLETE') {
        const id = currentItemIdRef.current
        currentItemIdRef.current = null
        if (id) {
          const item = queueRef.current.find(i => i.id === id)
          const gcodeFilename = item?.name.replace(/\.(stl|3mf|obj|step|stp|iges|igs)$/i, '.gcode') ?? 'output.gcode'
          updateQueue(q => q.map(i => i.id === id ? { ...i, status: 'done', gcode: msg.gcode, gcodeFilename } : i))
        }
        // Slice next item in queue
        startNextSlice()
        return
      }

      if (msg.type === 'SLICE_ERROR') {
        const id = currentItemIdRef.current
        currentItemIdRef.current = null
        if (id) {
          updateQueue(q => q.map(i => i.id === id ? { ...i, status: 'error', error: msg.message } : i))
        }
        // Continue with next item even after error
        startNextSlice()
        return
      }

      if (msg.type === 'SLICE_MULTI_COMPLETE') {
        setIsSlicingPlate(false)
        setPlateGcode(msg.gcode)
        return
      }

      if (msg.type === 'SLICE_MULTI_ERROR') {
        setIsSlicingPlate(false)
        setPlateError(msg.message)
        return
      }

      if (msg.type === 'OBJ_STL_COMPLETE') {
        const id = pendingObjConversionsRef.current.get(msg.filename)
        if (id) {
          pendingObjConversionsRef.current.delete(msg.filename)
          const stlFile = new File([msg.stl], msg.filename.replace(/\.obj$/i, '.stl'), { type: 'model/stl' })
          updateQueue(q => q.map(i => i.id === id ? { ...i, stlFile, status: 'ready', name: stlFile.name } : i))
        }
        return
      }

      if (msg.type === 'OBJ_STL_ERROR') {
        // Find any item still converting via OBJ (best-effort match)
        const convertingId = [...pendingObjConversionsRef.current.values()][0]
        if (convertingId) {
          pendingObjConversionsRef.current.clear()
          updateQueue(q => q.map(i => i.id === convertingId ? { ...i, status: 'error', error: `OBJ conversion failed: ${msg.message}` } : i))
        }
      }
    })

    return remove
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── File ingestion ────────────────────────────────────────────────────────────

  const handleFilesSelect = useCallback(async (newFiles: File[]) => {
    const newItems: QueueItem[] = newFiles.map(f => ({
      id: crypto.randomUUID(),
      name: f.name,
      originalSize: f.size,
      stlFile: null,
      status: 'converting' as const,
    }))

    updateQueue(q => [...q, ...newItems])

    for (let i = 0; i < newFiles.length; i++) {
      const f = newFiles[i]
      const { id } = newItems[i]

      try {
        if (/\.3mf$/i.test(f.name)) {
          const buf = await f.arrayBuffer()
          const { stlBytes, config: profileConfig } = parse3mf(buf)
          if (Object.keys(profileConfig).length > 0) {
            setConfigOverrides(profileConfig)
          }
          const stlFile = new File(
            [stlBytes.buffer as ArrayBuffer],
            f.name.replace(/\.3mf$/i, '.stl'),
            { type: 'model/stl' },
          )
          updateQueue(q => q.map(item => item.id === id ? { ...item, stlFile, status: 'ready', name: stlFile.name } : item))
        } else if (/\.(step|stp|iges|igs)$/i.test(f.name)) {
          const buf = await f.arrayBuffer()
          const stlBytes = await cadToStl(f.name, buf)
          const stlFile = new File(
            [stlBytes],
            f.name.replace(/\.(step|stp|iges|igs)$/i, '.stl'),
            { type: 'model/stl' },
          )
          updateQueue(q => q.map(item => item.id === id ? { ...item, stlFile, status: 'ready', name: stlFile.name } : item))
        } else if (/\.obj$/i.test(f.name)) {
          const buf = await f.arrayBuffer()
          pendingObjConversionsRef.current.set(f.name, id)
          getWorker().postMessage({ type: 'OBJ_TO_STL', obj: buf, filename: f.name }, [buf])
          // Stays 'converting' until OBJ_STL_COMPLETE
        } else {
          // STL — ready immediately
          updateQueue(q => q.map(item => item.id === id ? { ...item, stlFile: f, status: 'ready' } : item))
        }
      } catch (err) {
        updateQueue(q => q.map(item => item.id === id
          ? { ...item, status: 'error', error: err instanceof Error ? err.message : String(err) }
          : item))
      }
    }
  }, [updateQueue])

  const removeItem = useCallback((id: string) => {
    pendingObjConversionsRef.current.forEach((itemId, filename) => {
      if (itemId === id) pendingObjConversionsRef.current.delete(filename)
    })
    updateQueue(q => q.filter(i => i.id !== id))
  }, [updateQueue])

  const handleSliceAll = useCallback(async () => {
    if (currentItemIdRef.current) return  // already slicing
    await startNextSlice()
  }, [startNextSlice])

  const handleSlicePlate = useCallback(async () => {
    if (isSlicingPlate || wasmStatusRef.current !== 'ready') return
    const readyItems = queueRef.current.filter(i => i.status === 'ready' && i.stlFile != null)
    if (readyItems.length === 0) return

    setIsSlicingPlate(true)
    setPlateError(null)
    setPlateGcode(null)

    try {
      const stlBuffers = await Promise.all(readyItems.map(i => i.stlFile!.arrayBuffer()))
      getWorker().postMessage({ type: 'SLICE_MULTI', stls: stlBuffers, config: configRef.current! }, stlBuffers)
    } catch (err) {
      setIsSlicingPlate(false)
      setPlateError(err instanceof Error ? err.message : String(err))
    }
  }, [isSlicingPlate])

  // ── Settings helpers ──────────────────────────────────────────────────────────

  const handlePresetChange = (name: string) => {
    setSelectedPreset(name)
    setConfigOverrides({})
  }

  // ── Derived state ─────────────────────────────────────────────────────────────

  const readyForPlate = queue.filter(i => i.status === 'ready' && i.stlFile != null).length

  const previewFile = useMemo(
    () => queue.find(i => i.stlFile != null)?.stlFile ?? null,
    [queue],
  )
  const hasAnyReady = queue.some(i => i.stlFile != null)
  const readyCount = queue.filter(i => i.status === 'ready').length
  const doneCount = queue.filter(i => i.status === 'done').length
  const isSlicing = queue.some(i => i.status === 'slicing')
  const isConverting = queue.some(i => i.status === 'converting')

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-orca-50 flex flex-col">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <OrcaLogo className="w-7 h-7" />
            <span className="font-bold text-slate-800 tracking-tight">OrcaWeb</span>
            <span className="hidden sm:block text-xs text-slate-400 font-medium bg-slate-100 px-2 py-0.5 rounded-full">
              Browser Slicer
            </span>
            <span className="hidden md:block text-xs text-slate-400 font-mono">
              v{__APP_VERSION__} · {__APP_RELEASE_DATE__}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <WasmStatusBadge status={wasmStatus} />
            <a
              href="https://github.com/Hiosdra/OrcaWeb"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 hover:text-slate-600 transition-colors"
            >
              <GithubIcon className="w-5 h-5" />
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        <nav className="flex gap-1 p-1 bg-slate-100 rounded-xl mb-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              disabled={tab.id !== 'upload' && !hasAnyReady}
              className={clsx(
                'flex-1 py-2 rounded-lg text-sm font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-white text-orca-600 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* ── Upload tab ── */}
        {activeTab === 'upload' && (
          <div className="space-y-4">
            <FileUpload loadedCount={queue.length} onFiles={handleFilesSelect} />

            {queue.length > 0 && (
              <div className="space-y-2">
                {queue.map(item => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 px-4 py-3 bg-white rounded-xl border border-slate-200"
                  >
                    <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-slate-50">
                      {item.status === 'converting' ? (
                        <SpinnerIcon className="w-4 h-4 text-amber-500 animate-spin" />
                      ) : item.status === 'error' ? (
                        <ErrorDotIcon className="w-4 h-4 text-red-400" />
                      ) : (
                        <ModelIconSm className="w-4 h-4 text-orca-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
                      {item.status === 'converting' && (
                        <p className="text-xs text-amber-600">Converting…</p>
                      )}
                      {item.status === 'error' && (
                        <p className="text-xs text-red-500 truncate">{item.error}</p>
                      )}
                      {(item.status === 'ready' || item.status === 'done') && item.originalSize > 0 && (
                        <p className="text-xs text-slate-400">{formatBytes(item.originalSize)}</p>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeItem(item.id) }}
                      title="Remove"
                      className="text-slate-300 hover:text-red-400 transition-colors p-1"
                    >
                      <XIcon className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {previewFile && (
              <div className="rounded-2xl overflow-hidden border border-slate-200 bg-white" style={{ height: 300 }}>
                <ModelViewer file={previewFile} bedX={bedX} bedY={bedY} bedShape={bedShape} />
              </div>
            )}

            {hasAnyReady && (
              <button
                onClick={() => setActiveTab('settings')}
                className="w-full py-3 rounded-xl bg-orca-500 hover:bg-orca-600 text-white font-semibold transition-colors"
              >
                Continue to settings →
              </button>
            )}

            {isConverting && !hasAnyReady && (
              <p className="text-sm text-center text-slate-400">Converting files…</p>
            )}
          </div>
        )}

        {/* ── Settings tab ── */}
        {activeTab === 'settings' && hasAnyReady && (
          <div className="grid sm:grid-cols-[1fr_1.4fr] gap-6">
            {previewFile && (
              <div
                className="rounded-2xl overflow-hidden border border-slate-200 bg-white order-last sm:order-first"
                style={{ height: 320 }}
              >
                <ModelViewer file={previewFile} bedX={bedX} bedY={bedY} bedShape={bedShape} />
              </div>
            )}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-y-auto">
              <SettingsPanel
                config={config}
                onChange={(patch) => setConfigOverrides((prev) => ({ ...prev, ...patch }))}
                selectedPreset={selectedPreset}
                onPresetChange={handlePresetChange}
                selectedPrinter={selectedPrinter}
                onPrinterChange={(name) => { setSelectedPrinter(name); setConfigOverrides({}) }}
                selectedFilament={selectedFilament}
                onFilamentChange={(name) => { setSelectedFilament(name); setConfigOverrides({}) }}
              />
              <button
                onClick={() => setActiveTab('slice')}
                className="mt-6 w-full py-3 rounded-xl bg-orca-500 hover:bg-orca-600 text-white font-semibold transition-colors"
              >
                Ready to slice →
              </button>
            </div>
          </div>
        )}

        {/* ── Slice tab ── */}
        {activeTab === 'slice' && queue.length > 0 && (
          <div className="space-y-4">
            <SliceHeader
              readyCount={readyCount}
              doneCount={doneCount}
              totalCount={queue.length}
              isSlicing={isSlicing}
              wasmStatus={wasmStatus}
              onSliceAll={handleSliceAll}
              queue={queue}
              readyForPlate={readyForPlate}
              isSlicingPlate={isSlicingPlate}
              onSlicePlate={handleSlicePlate}
            />

            {(plateGcode || isSlicingPlate || plateError) && (
              <PlateResultCard
                gcode={plateGcode}
                isSlicing={isSlicingPlate}
                error={plateError}
                bedX={bedX}
                bedY={bedY}
                bedShape={bedShape}
              />
            )}

            <div className="space-y-3">
              {queue.map(item => (
                <QueueItemCard
                  key={item.id}
                  item={item}
                  bedX={bedX}
                  bedY={bedY}
                  bedShape={bedShape}
                />
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h2 className="font-semibold text-slate-800 mb-4">Slice settings</h2>
              <ConfigSummary config={config} fileCount={queue.length} />
            </div>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-slate-400 py-4 border-t border-slate-100">
        Powered by{' '}
        <a
          href="https://github.com/SoftFever/OrcaSlicer"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-slate-600"
        >
          OrcaSlicer
        </a>{' '}
        · All slicing runs locally in your browser ·{' '}
        <a
          href="https://github.com/Hiosdra/OrcaWeb"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-slate-600"
        >
          Source (AGPL-3.0)
        </a>
      </footer>
    </div>
  )
}

// ── Slice header ──────────────────────────────────────────────────────────────

function SliceHeader({
  readyCount,
  doneCount,
  totalCount,
  isSlicing,
  wasmStatus,
  onSliceAll,
  queue,
  readyForPlate,
  isSlicingPlate,
  onSlicePlate,
}: {
  readyCount: number
  doneCount: number
  totalCount: number
  isSlicing: boolean
  wasmStatus: WasmStatus
  onSliceAll: () => void
  queue: QueueItem[]
  readyForPlate: number
  isSlicingPlate: boolean
  onSlicePlate: () => void
}) {
  const busyCount = queue.filter(i => i.status === 'slicing').length
  const slicedCount = doneCount + busyCount
  const allDone = totalCount > 0 && doneCount + queue.filter(i => i.status === 'error').length === totalCount
  const canSlice = (readyCount > 0 || isSlicing) && !allDone
  const canPlate = readyForPlate >= 2 && !isSlicingPlate && wasmStatus === 'ready'

  const sliceLabel = isSlicing
    ? `Slicing… (${slicedCount}/${totalCount})`
    : readyCount > 0
    ? `Slice${readyCount > 1 ? ' All' : ''} (${readyCount} file${readyCount !== 1 ? 's' : ''})`
    : allDone
    ? 'All files sliced'
    : 'Slice'

  return (
    <div className="flex flex-wrap gap-3 items-center">
      <button
        onClick={onSliceAll}
        disabled={!canSlice || isSlicing}
        className={clsx(
          'flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all shadow-sm',
          isSlicing
            ? 'bg-orca-400 text-white cursor-wait'
            : canSlice
            ? 'bg-orca-500 hover:bg-orca-600 text-white'
            : 'bg-slate-200 text-slate-400 cursor-not-allowed',
        )}
      >
        {isSlicing ? <SpinnerIcon className="w-4 h-4 animate-spin" /> : <SliceIcon className="w-4 h-4" />}
        {sliceLabel}
      </button>

      {readyForPlate >= 2 && (
        <button
          onClick={onSlicePlate}
          disabled={!canPlate}
          title="Arrange all files on one plate and slice together"
          className={clsx(
            'flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all shadow-sm border',
            isSlicingPlate
              ? 'bg-orca-50 border-orca-300 text-orca-500 cursor-wait'
              : canPlate
              ? 'bg-white border-orca-300 text-orca-600 hover:bg-orca-50'
              : 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed',
          )}
        >
          {isSlicingPlate ? <SpinnerIcon className="w-4 h-4 animate-spin" /> : <PlateIcon className="w-4 h-4" />}
          {isSlicingPlate ? 'Slicing plate…' : `One plate (${readyForPlate})`}
        </button>
      )}

      {doneCount > 1 && (
        <button
          onClick={() => downloadAll(queue)}
          className="flex items-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm bg-green-600 hover:bg-green-700 text-white transition-colors"
        >
          <DownloadIcon className="w-4 h-4" />
          Download All ({doneCount})
        </button>
      )}

      {wasmStatus === 'loading' && readyCount === 0 && !isSlicing && (
        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Loading slicer engine…
        </span>
      )}

      <p className="ml-auto text-xs text-slate-400 hidden sm:block">
        All processing runs locally — your files never leave your device.
      </p>
    </div>
  )
}

// ── Queue item card ───────────────────────────────────────────────────────────

function QueueItemCard({
  item,
  bedX,
  bedY,
  bedShape,
}: {
  item: QueueItem
  bedX: number
  bedY: number
  bedShape: 'rectangle' | 'circle'
}) {
  const [expanded, setExpanded] = useState(false)
  const printTime = item.gcode ? extractPrintTime(item.gcode) : undefined

  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border transition-colors overflow-hidden',
        item.status === 'done' ? 'border-green-200' : item.status === 'error' ? 'border-red-200' : 'border-slate-200',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Status indicator */}
        <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg">
          {item.status === 'converting' && <SpinnerIcon className="w-5 h-5 text-amber-500 animate-spin" />}
          {item.status === 'ready' && <ClockIcon className="w-5 h-5 text-slate-400" />}
          {item.status === 'slicing' && <SpinnerIcon className="w-5 h-5 text-orca-500 animate-spin" />}
          {item.status === 'done' && <CheckCircleIcon className="w-5 h-5 text-green-500" />}
          {item.status === 'error' && <ErrorCircleIcon className="w-5 h-5 text-red-400" />}
        </div>

        {/* Name + status text */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
          <p className={clsx('text-xs', {
            'text-amber-600': item.status === 'converting',
            'text-slate-400': item.status === 'ready',
            'text-orca-600': item.status === 'slicing',
            'text-green-600': item.status === 'done',
            'text-red-500': item.status === 'error',
          })}>
            {item.status === 'converting' && 'Converting…'}
            {item.status === 'ready' && 'Ready to slice'}
            {item.status === 'slicing' && <SlicingLabel />}
            {item.status === 'done' && (printTime ? `Done · ${printTime}` : 'Done')}
            {item.status === 'error' && (item.error ?? 'Error')}
          </p>
        </div>

        {/* Actions */}
        {item.status === 'done' && item.gcode && item.gcodeFilename && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded(e => !e)}
              title="Preview G-code"
              className="text-slate-300 hover:text-slate-600 transition-colors p-1"
            >
              <EyeIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => downloadGcode(item.gcode!, item.gcodeFilename!)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors"
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
          </div>
        )}
      </div>

      {/* Expanded G-code viewer */}
      {expanded && item.stlFile && item.gcode && (
        <div className="border-t border-slate-100">
          <div className="grid sm:grid-cols-2" style={{ height: 300 }}>
            <div className="border-r border-slate-100">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Model</div>
              <div style={{ height: 270 }}>
                <ModelViewer file={item.stlFile} bedX={bedX} bedY={bedY} bedShape={bedShape} />
              </div>
            </div>
            <div className="bg-slate-900">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">G-code</div>
              <div style={{ height: 270 }}>
                <GcodeViewer gcode={item.gcode} bedX={bedX} bedY={bedY} bedShape={bedShape} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Plate result card ─────────────────────────────────────────────────────────

function PlateResultCard({
  gcode,
  isSlicing,
  error,
  bedX,
  bedY,
  bedShape,
}: {
  gcode: string | null
  isSlicing: boolean
  error: string | null
  bedX: number
  bedY: number
  bedShape: 'rectangle' | 'circle'
}) {
  const [expanded, setExpanded] = useState(false)
  const printTime = gcode ? extractPrintTime(gcode) : undefined

  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border overflow-hidden',
        isSlicing ? 'border-orca-200' : error ? 'border-red-200' : 'border-green-200',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-slate-50">
          {isSlicing && <SpinnerIcon className="w-5 h-5 text-orca-500 animate-spin" />}
          {!isSlicing && error && <ErrorCircleIcon className="w-5 h-5 text-red-400" />}
          {!isSlicing && gcode && <CheckCircleIcon className="w-5 h-5 text-green-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800">
            Plate G-code
          </p>
          <p className={clsx('text-xs', {
            'text-orca-600': isSlicing,
            'text-red-500': !!error,
            'text-green-600': !!gcode && !error,
          })}>
            {isSlicing && <SlicingLabel />}
            {!isSlicing && error && error}
            {!isSlicing && gcode && (printTime ? `Done · ${printTime}` : 'Done')}
          </p>
        </div>
        {gcode && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded(e => !e)}
              title="Preview G-code"
              className="text-slate-300 hover:text-slate-600 transition-colors p-1"
            >
              <EyeIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => downloadGcode(gcode, 'plate.gcode')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors"
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
          </div>
        )}
      </div>

      {expanded && gcode && (
        <div className="border-t border-slate-100 bg-slate-900" style={{ height: 300 }}>
          <GcodeViewer gcode={gcode} bedX={bedX} bedY={bedY} bedShape={bedShape} />
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPrintTime(gcode: string): string | undefined {
  return gcode.match(/;\s*estimated printing time[^=]*=\s*(.+)/i)?.[1]?.trim()
}

function downloadGcode(gcode: string, filename: string) {
  const blob = new Blob([gcode], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function downloadAll(queue: QueueItem[]) {
  const done = queue.filter(i => i.status === 'done' && i.gcode && i.gcodeFilename)
  done.forEach((item, idx) => {
    setTimeout(() => downloadGcode(item.gcode!, item.gcodeFilename!), idx * 100)
  })
}

function SlicingLabel() {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(id)
  }, [])
  return <>Slicing… ({elapsed}s)</>
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WasmStatusBadge({ status }: { status: WasmStatus }) {
  if (status === 'ready' || status === 'idle') return null
  return (
    <div
      className={clsx(
        'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full',
        status === 'loading' && 'bg-amber-50 text-amber-700',
        status === 'error' && 'bg-red-50 text-red-600',
      )}
    >
      {status === 'loading' && (
        <>
          <SpinnerIcon className="w-3 h-3 animate-spin" />
          Loading engine…
        </>
      )}
      {status === 'error' && (
        <>
          <ErrorDotIcon className="w-3 h-3" />
          Engine error
        </>
      )}
    </div>
  )
}

function ConfigSummary({ config, fileCount }: { config: OrcaConfig; fileCount: number }) {
  const rows: [string, string][] = [
    ['Files', `${fileCount} file${fileCount !== 1 ? 's' : ''}`],
    ['Printer', config.printer_model ?? 'Generic'],
    ['Material', config.filament_type ?? 'PLA'],
    ['Layer height', `${config.layer_height ?? 0.2} mm`],
    ['Infill', `${config.sparse_infill_density ?? 15}% ${config.sparse_infill_pattern ?? 'grid'}`],
    ['Walls', String(config.wall_loops ?? 3)],
    ['Nozzle temp', `${config.nozzle_temperature ?? 220}°C`],
    ['Supports', config.enable_support ? (config.support_type ?? 'auto') : 'none'],
  ]
  return (
    <dl className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between text-sm">
          <dt className="text-slate-500">{label}</dt>
          <dd className="font-medium text-slate-800 text-right">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function OrcaLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#0a84ff" />
      <path d="M8 22 L16 8 L24 22" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 18 L21 18" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  )
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

function PlateIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 13v8m-4-4h8" />
    </svg>
  )
}

function SliceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  )
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  )
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function ModelIconSm({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  )
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ErrorCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  )
}

function ErrorDotIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}
