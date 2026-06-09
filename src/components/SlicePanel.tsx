import clsx from 'clsx'
import type { SliceStatus } from '../types'
import type { WasmStatus } from '../lib/worker-singleton'

interface Props {
  status: SliceStatus
  wasmStatus: WasmStatus
  onSlice: () => void
  disabled: boolean
}

export function SlicePanel({ status, wasmStatus, onSlice, disabled }: Props) {
  const isIdle = status.phase === 'idle'
  const isLoading = status.phase === 'loading-wasm' || status.phase === 'slicing'
  const isDone = status.phase === 'done'
  const isError = status.phase === 'error'
  const engineLoading = wasmStatus === 'loading' && isIdle

  return (
    <div className="space-y-4">
      <button
        onClick={onSlice}
        disabled={disabled || isLoading}
        className={clsx(
          'w-full py-4 rounded-2xl font-semibold text-lg transition-all shadow-sm',
          'flex items-center justify-center gap-3',
          isLoading
            ? 'bg-orca-400 text-white cursor-wait'
            : disabled
            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
            : 'bg-orca-500 hover:bg-orca-600 active:bg-orca-700 text-white shadow-orca-200 hover:shadow-md',
        )}
      >
        {isLoading ? (
          <>
            <Spinner />
            {status.phase === 'loading-wasm' ? 'Loading slicer engine…' : 'Slicing…'}
          </>
        ) : (
          <>
            <SliceIcon />
            Slice model
          </>
        )}
      </button>

      {isError && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4">
          <div className="flex gap-3">
            <ErrorIcon className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-700 text-sm">Slicing failed</p>
              <p className="text-sm text-red-600 mt-0.5">{(status as { phase: 'error'; message: string }).message}</p>
            </div>
          </div>
        </div>
      )}

      {isDone && status.phase === 'done' && (
        <div className="rounded-xl bg-green-50 border border-green-200 p-4 space-y-3">
          <div className="flex gap-3 items-start">
            <CheckIcon className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-green-800 text-sm">Slicing complete!</p>
              <p className="text-xs text-green-700 mt-0.5">
                {formatGcodeStats(status.gcode)}
              </p>
            </div>
          </div>
          <button
            onClick={() => downloadGcode(status.gcode, status.filename)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white font-semibold text-sm transition-colors"
          >
            <DownloadIcon className="w-4 h-4" />
            Download G-code
          </button>
          <GcodePreview gcode={status.gcode} />
        </div>
      )}

      {engineLoading && (
        <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          <span>Loading slicer engine in the background — slicing will start automatically when ready.</span>
        </div>
      )}

      {(isIdle || isLoading) && !isDone && !isError && !engineLoading && (
        <p className="text-xs text-center text-slate-400">
          All processing runs locally in your browser — your files never leave your device.
        </p>
      )}
    </div>
  )
}

function GcodePreview({ gcode }: { gcode: string }) {
  const lines = gcode.split('\n').slice(0, 50).join('\n')
  return (
    <details className="mt-1">
      <summary className="text-xs text-green-700 cursor-pointer hover:text-green-900 font-medium">
        Preview G-code (first 50 lines)
      </summary>
      <pre className="mt-2 text-xs bg-slate-900 text-green-400 rounded-lg p-3 overflow-auto max-h-48 font-mono leading-relaxed">
        {lines}
      </pre>
    </details>
  )
}

function formatGcodeStats(gcode: string): string {
  const lines = gcode.split('\n').length
  const bytes = new TextEncoder().encode(gcode).length
  const timeMatch = gcode.match(/; estimated printing time[^=]+=\s*(.+)/i)
  const time = timeMatch ? ` · ${timeMatch[1].trim()}` : ''
  return `${lines.toLocaleString()} lines · ${formatBytes(bytes)}${time}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function downloadGcode(gcode: string, filename: string) {
  const blob = new Blob([gcode], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function Spinner() {
  return (
    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

function SliceIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
    </svg>
  )
}
