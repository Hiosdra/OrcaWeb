import { useState, useEffect, useRef, useCallback } from 'react'
import clsx from 'clsx'
import { FileUpload } from './components/FileUpload'
import { ModelViewer } from './components/ModelViewer'
import { SettingsPanel } from './components/SettingsPanel'
import { SlicePanel } from './components/SlicePanel'
import { GcodeViewer } from './components/GcodeViewer'
import type { OrcaConfig, SliceStatus, WorkerOutMessage } from './types'
import { buildConfig } from './lib/profiles'
import { parse3mf } from './lib/parse3mf'
import { cadToStl } from './lib/step-converter'
import {
  getWorker,
  addWorkerListener,
  getWasmStatus,
  getWasmError,
  type WasmStatus,
} from './lib/worker-singleton'

type Tab = 'upload' | 'settings' | 'slice'

const TABS: { id: Tab; label: string }[] = [
  { id: 'upload', label: 'Model' },
  { id: 'settings', label: 'Settings' },
  { id: 'slice', label: 'Slice' },
]

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('upload')

  const [selectedPreset, setSelectedPreset] = useState('standard')
  const [selectedPrinter, setSelectedPrinter] = useState('Generic 0.4')
  const [selectedFilament, setSelectedFilament] = useState('PLA')
  const [configOverrides, setConfigOverrides] = useState<Partial<OrcaConfig>>({})
  const [sliceStatus, setSliceStatus] = useState<SliceStatus>({ phase: 'idle' })
  const [wasmStatus, setWasmStatus] = useState<WasmStatus>(getWasmStatus)

  // Pending slice: holds STL + config while WASM loads
  const pendingSliceRef = useRef<{ stl: ArrayBuffer; config: OrcaConfig } | null>(null)
  const fileRef = useRef<File | null>(null)
  // Filename saved during OBJ→STL conversion (to name the synthetic STL file)
  const pendingObjFilenameRef = useRef<string | null>(null)

  const config: OrcaConfig = {
    ...buildConfig(selectedPrinter, selectedFilament, selectedPreset),
    ...configOverrides,
  }

  const bedX = config.bed_size_x ?? 256
  const bedY = config.bed_size_y ?? 256

  useEffect(() => { fileRef.current = file }, [file])

  // Subscribe to singleton worker events — no worker creation here
  useEffect(() => {
    // Ensure worker+WASM are started (idempotent)
    getWorker()

    const remove = addWorkerListener((msg: WorkerOutMessage) => {
      if (msg.type === 'WASM_LOADED') {
        setWasmStatus('ready')
        if (pendingSliceRef.current) {
          const pending = pendingSliceRef.current
          pendingSliceRef.current = null
          setSliceStatus({ phase: 'slicing' })
          getWorker().postMessage(
            { type: 'SLICE', stl: pending.stl, config: pending.config },
            [pending.stl],
          )
        }
      } else if (msg.type === 'WASM_ERROR') {
        setWasmStatus('error')
        pendingSliceRef.current = null
        setSliceStatus({
          phase: 'error',
          message: `Failed to load slicer engine: ${msg.message}. Make sure WASM artifacts are in public/wasm/ (run: node scripts/download-wasm.mjs)`,
        })
      } else if (msg.type === 'SLICE_COMPLETE') {
        const filename = fileRef.current?.name.replace(/\.stl$/i, '.gcode') ?? 'output.gcode'
        setSliceStatus({ phase: 'done', gcode: msg.gcode, filename })
      } else if (msg.type === 'SLICE_ERROR') {
        setSliceStatus({ phase: 'error', message: msg.message })
      } else if (msg.type === 'OBJ_STL_COMPLETE') {
        const name = pendingObjFilenameRef.current ?? 'model.stl'
        pendingObjFilenameRef.current = null
        const stlFile = new File(
          [msg.stl],
          name.replace(/\.obj$/i, '.stl'),
          { type: 'model/stl' },
        )
        setFile(stlFile)
        setConfigOverrides({})
        setSliceStatus({ phase: 'idle' })
        setActiveTab('settings')
      } else if (msg.type === 'OBJ_STL_ERROR') {
        pendingObjFilenameRef.current = null
        setSliceStatus({
          phase: 'error',
          message: `Failed to convert OBJ: ${msg.message}`,
        })
      }
    })

    return remove // just remove listener, don't kill the worker
  }, [])

  const handleFileSelect = useCallback(async (f: File) => {
    setSliceStatus({ phase: 'idle' })
    if (/\.3mf$/i.test(f.name)) {
      try {
        const buf = await f.arrayBuffer()
        const { stlBytes, config: profileConfig } = parse3mf(buf)
        // Apply any settings extracted from the 3MF metadata
        if (Object.keys(profileConfig).length > 0) {
          setConfigOverrides((prev) => ({ ...prev, ...profileConfig }))
        }
        // Wrap extracted STL bytes as a synthetic File so ModelViewer can read it
        const stlFile = new File([stlBytes.buffer as ArrayBuffer], f.name.replace(/\.3mf$/i, '.stl'), {
          type: 'model/stl',
        })
        setFile(stlFile)
      } catch (err) {
        setSliceStatus({
          phase: 'error',
          message: `Failed to parse 3MF: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }
    } else if (/\.(step|stp|iges|igs)$/i.test(f.name)) {
      try {
        setSliceStatus({ phase: 'loading-wasm' })
        const buf = await f.arrayBuffer()
        const stlBytes = await cadToStl(f.name, buf)
        const stlFile = new File(
          [stlBytes],
          f.name.replace(/\.(step|stp|iges|igs)$/i, '.stl'),
          { type: 'model/stl' },
        )
        setFile(stlFile)
        setConfigOverrides({})
        setSliceStatus({ phase: 'idle' })
      } catch (err) {
        setSliceStatus({
          phase: 'error',
          message: `Failed to convert STEP/IGES: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }
    } else if (/\.obj$/i.test(f.name)) {
      setSliceStatus({ phase: 'loading-wasm' })
      pendingObjFilenameRef.current = f.name
      const buf = await f.arrayBuffer()
      getWorker().postMessage({ type: 'OBJ_TO_STL', obj: buf }, [buf])
      return // state update happens in the OBJ_STL_COMPLETE listener
    } else {
      setFile(f)
      // Clear any 3MF-extracted overrides so they don't bleed into plain STL slices
      setConfigOverrides({})
    }
    setActiveTab('settings')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePresetChange = (name: string) => {
    setSelectedPreset(name)
    setConfigOverrides({})
  }

  const handleSlice = async () => {
    if (!file) return
    const stlBuffer = await file.arrayBuffer()

    if (wasmStatus === 'ready') {
      setSliceStatus({ phase: 'slicing' })
      getWorker().postMessage(
        { type: 'SLICE', stl: stlBuffer, config },
        [stlBuffer],
      )
    } else if (wasmStatus === 'loading') {
      setSliceStatus({ phase: 'loading-wasm' })
      pendingSliceRef.current = { stl: stlBuffer, config }
    } else if (wasmStatus === 'error') {
      setSliceStatus({
        phase: 'error',
        message: `Slicer engine failed to load: ${getWasmError()}`,
      })
    }
  }

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
              disabled={tab.id !== 'upload' && !file}
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

        {activeTab === 'upload' && (
          <div className="space-y-4">
            <FileUpload file={file} onFile={handleFileSelect} />
            {sliceStatus.phase === 'error' && !file && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {sliceStatus.message}
              </div>
            )}
            {file && (
              <div className="rounded-2xl overflow-hidden border border-slate-200 bg-white" style={{ height: 360 }}>
                <ModelViewer file={file} bedX={bedX} bedY={bedY} />
              </div>
            )}
            {file && (
              <button
                onClick={() => setActiveTab('settings')}
                className="w-full py-3 rounded-xl bg-orca-500 hover:bg-orca-600 text-white font-semibold transition-colors"
              >
                Continue to settings →
              </button>
            )}
          </div>
        )}

        {activeTab === 'settings' && file && (
          <div className="grid sm:grid-cols-[1fr_1.4fr] gap-6">
            <div
              className="rounded-2xl overflow-hidden border border-slate-200 bg-white order-last sm:order-first"
              style={{ height: 320 }}
            >
              <ModelViewer file={file} bedX={bedX} bedY={bedY} />
            </div>
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

        {activeTab === 'slice' && file && (
          <div className={sliceStatus.phase === 'done' ? 'space-y-4' : 'max-w-md mx-auto space-y-4'}>
            {sliceStatus.phase === 'done' ? (
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="rounded-2xl overflow-hidden border border-slate-200 bg-white" style={{ height: 420 }}>
                  <div className="px-4 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-wider">Model</div>
                  <div style={{ height: 380 }}>
                    <ModelViewer file={file} bedX={bedX} bedY={bedY} />
                  </div>
                </div>
                <div className="rounded-2xl overflow-hidden border border-slate-800" style={{ height: 420 }}>
                  <div className="px-4 pt-3 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-900">G-code</div>
                  <div style={{ height: 380 }}>
                    <GcodeViewer gcode={sliceStatus.gcode} bedX={bedX} bedY={bedY} />
                  </div>
                </div>
              </div>
            ) : null}
            <div className={sliceStatus.phase === 'done' ? 'grid sm:grid-cols-2 gap-4' : ''}>
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h2 className="font-semibold text-slate-800 mb-4">Slice summary</h2>
                <ConfigSummary config={config} filename={file.name} />
              </div>
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <SlicePanel
                  status={sliceStatus}
                  wasmStatus={wasmStatus}
                  onSlice={handleSlice}
                  disabled={!file}
                />
              </div>
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

function WasmStatusBadge({ status }: { status: WasmStatus }) {
  if (status === 'ready') return null // clean UI when ready
  if (status === 'idle') return null

  return (
    <div
      className={clsx(
        'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full',
        status === 'loading' && 'bg-amber-50 text-amber-700',
        status === 'error'   && 'bg-red-50 text-red-600',
      )}
    >
      {status === 'loading' && (
        <>
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Loading engine…
        </>
      )}
      {status === 'error' && (
        <>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          Engine error
        </>
      )}
    </div>
  )
}

function ConfigSummary({ config, filename }: { config: OrcaConfig; filename: string }) {
  const rows: [string, string][] = [
    ['File', filename],
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
