import { useState, useEffect, useMemo } from 'react'
import clsx from 'clsx'
import { zipSync, strToU8 } from 'fflate'
import type { OrcaConfig, QueueItem } from '../types'
import type { WasmStatus } from '../lib/worker-singleton'
import type { PlateState } from '../hooks/useSliceQueue'
import { extractGcodeStats, gcodeStatsLabel } from '../lib/gcode-stats'
import { DISPLAY_DEFAULTS } from '../lib/profiles'
import { ModelViewer } from './ModelViewer'
import { GcodeViewer } from './GcodeViewer'
import {
  SpinnerIcon, PlateIcon, SliceIcon, DownloadIcon, XIcon,
  CheckCircleIcon, ErrorCircleIcon, ClockIcon, EyeIcon,
} from './icons'

interface BedProps {
  bedX: number
  bedY: number
  bedShape: 'rectangle' | 'circle'
}

// ── Download helpers ──────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function downloadGcode(gcode: string, filename: string) {
  downloadBlob(new Blob([gcode], { type: 'text/plain' }), filename)
}

// One ZIP instead of N staggered programmatic downloads — browsers block all
// but the first download that isn't tied to a direct user gesture.
function downloadAllAsZip(queue: QueueItem[]) {
  const files: Record<string, Uint8Array> = {}
  for (const item of queue) {
    if (item.status !== 'done' || !item.gcode || !item.gcodeFilename) continue
    let name = item.gcodeFilename
    for (let n = 2; name in files; n++) name = item.gcodeFilename.replace(/\.gcode$/i, `-${n}.gcode`)
    files[name] = strToU8(item.gcode)
  }
  // G-code is highly repetitive; level 6 halves the archive at negligible cost
  const zipped = zipSync(files, { level: 6 })
  // Pass the view, not .buffer — Blob respects the view's offset/length,
  // while a raw buffer would leak padding if the array were ever a subarray.
  downloadBlob(new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'orcaweb-gcode.zip')
}

// ── Slice header ──────────────────────────────────────────────────────────────

export function SliceHeader({
  queue,
  plate,
  wasmStatus,
  onSliceAll,
  onSlicePlate,
  onCancel,
}: {
  queue: QueueItem[]
  plate: PlateState
  wasmStatus: WasmStatus
  onSliceAll: () => void
  onSlicePlate: () => void
  onCancel: () => void
}) {
  const totalCount = queue.length
  const readyCount = queue.filter(i => i.status === 'ready').length
  const staleCount = queue.filter(i => i.status === 'done' && i.stale).length
  const doneCount = queue.filter(i => i.status === 'done').length
  const errorCount = queue.filter(i => i.status === 'error').length
  const busyCount = queue.filter(i => i.status === 'slicing').length
  const isSlicing = busyCount > 0
  const sliceableCount = readyCount + staleCount

  const readyForPlate = queue.filter(i => i.status === 'ready' && i.stlFile != null).length
  const allDone = totalCount > 0 && doneCount + errorCount === totalCount && staleCount === 0
  const canSlice = sliceableCount > 0 && !isSlicing
  const canPlate = readyForPlate >= 2 && !plate.slicing && wasmStatus === 'ready'

  const sliceLabel = isSlicing
    ? `Slicing… (${doneCount + busyCount}/${totalCount})`
    : staleCount > 0
    ? `Re-slice (${sliceableCount} file${sliceableCount !== 1 ? 's' : ''})`
    : sliceableCount > 0
    ? `Slice${sliceableCount > 1 ? ' All' : ''} (${sliceableCount} file${sliceableCount !== 1 ? 's' : ''})`
    : allDone
    ? 'All files sliced'
    : 'Slice'

  return (
    <div className="flex flex-wrap gap-3 items-center">
      <button
        onClick={onSliceAll}
        disabled={!canSlice}
        data-testid="slice-all-button"
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

      {(isSlicing || plate.slicing) && (
        <button
          onClick={onCancel}
          data-testid="cancel-slice-button"
          className="flex items-center gap-1.5 px-4 py-3 rounded-xl font-semibold text-sm border border-slate-300 text-slate-600 hover:border-red-300 hover:text-red-500 transition-colors"
        >
          <XIcon className="w-4 h-4" />
          Cancel
        </button>
      )}

      {readyForPlate >= 2 && (
        <button
          onClick={onSlicePlate}
          disabled={!canPlate}
          title="Arrange all files on one plate and slice together"
          className={clsx(
            'flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all shadow-sm border',
            plate.slicing
              ? 'bg-orca-50 border-orca-300 text-orca-500 cursor-wait'
              : canPlate
              ? 'bg-white border-orca-300 text-orca-600 hover:bg-orca-50'
              : 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed',
          )}
        >
          {plate.slicing ? <SpinnerIcon className="w-4 h-4 animate-spin" /> : <PlateIcon className="w-4 h-4" />}
          {plate.slicing ? 'Slicing plate…' : `One plate (${readyForPlate})`}
        </button>
      )}

      {doneCount > 1 && (
        <button
          onClick={() => downloadAllAsZip(queue)}
          className="flex items-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm bg-green-600 hover:bg-green-700 text-white transition-colors"
        >
          <DownloadIcon className="w-4 h-4" />
          Download All (.zip)
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

export function QueueItemCard({
  item, bedX, bedY, bedShape, onExport3mf,
}: { item: QueueItem; onExport3mf: (item: QueueItem) => Promise<ArrayBuffer> } & BedProps) {
  const [expanded, setExpanded] = useState(false)
  const [exporting3mf, setExporting3mf] = useState(false)
  const [export3mfError, setExport3mfError] = useState<string | null>(null)
  const statsLabel = useMemo(
    () => (item.gcode ? gcodeStatsLabel(extractGcodeStats(item.gcode)) : ''),
    [item.gcode],
  )

  const handleExport3mf = async () => {
    setExporting3mf(true)
    setExport3mfError(null)
    try {
      const data = await onExport3mf(item)
      const name = item.name.replace(/\.\w+$/, '') + '.3mf'
      downloadBlob(new Blob([data], { type: 'model/3mf' }), name)
    } catch (err) {
      setExport3mfError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting3mf(false)
    }
  }

  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border transition-colors overflow-hidden',
        item.status === 'done'
          ? item.stale ? 'border-amber-200' : 'border-green-200'
          : item.status === 'error' ? 'border-red-200' : 'border-slate-200',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg">
          {item.status === 'converting' && <SpinnerIcon className="w-5 h-5 text-amber-500 animate-spin" />}
          {item.status === 'ready' && <ClockIcon className="w-5 h-5 text-slate-400" />}
          {item.status === 'slicing' && <SpinnerIcon className="w-5 h-5 text-orca-500 animate-spin" />}
          {item.status === 'done' && <CheckCircleIcon className={clsx('w-5 h-5', item.stale ? 'text-amber-500' : 'text-green-500')} />}
          {item.status === 'error' && <ErrorCircleIcon className="w-5 h-5 text-red-400" />}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 truncate">{item.name}</p>
          <p
            data-testid="queue-item-status"
            className={clsx('text-xs', {
              'text-amber-600': item.status === 'converting' || (item.status === 'done' && item.stale),
              'text-slate-400': item.status === 'ready',
              'text-orca-600': item.status === 'slicing',
              'text-green-600': item.status === 'done' && !item.stale,
              'text-red-500': item.status === 'error',
            })}
          >
            {item.status === 'converting' && 'Converting…'}
            {item.status === 'ready' && 'Ready to slice'}
            {item.status === 'slicing' && <SlicingLabel />}
            {item.status === 'done' && (
              item.stale
                ? 'Sliced with previous settings — re-slice to apply changes'
                : (statsLabel ? `Done · ${statsLabel}` : 'Done')
            )}
            {item.status === 'error' && (item.error ?? 'Error')}
          </p>
        </div>

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
              data-testid="download-gcode-button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors"
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
            <button
              onClick={handleExport3mf}
              disabled={exporting3mf}
              title={
                item.stale
                  ? 'Exports current settings, which differ from the ones used for the G-code above — re-slice first to keep both in sync'
                  : 'Export mesh + settings as a .3mf, re-openable in desktop OrcaSlicer'
              }
              data-testid="export-3mf-button"
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors',
                exporting3mf
                  ? 'border-slate-200 text-slate-400 cursor-wait'
                  : item.stale
                  ? 'border-amber-300 text-amber-600 hover:border-amber-400'
                  : 'border-slate-300 text-slate-600 hover:border-orca-300 hover:text-orca-600',
              )}
            >
              {exporting3mf ? <SpinnerIcon className="w-3.5 h-3.5 animate-spin" /> : <DownloadIcon className="w-3.5 h-3.5" />}
              {exporting3mf ? 'Exporting…' : item.stale ? '.3mf*' : '.3mf'}
            </button>
          </div>
        )}
      </div>

      {export3mfError && (
        <div className="px-4 pb-3 -mt-1 text-xs text-red-500">
          3MF export failed: {export3mfError}
        </div>
      )}

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

export function PlateResultCard({ plate, bedX, bedY, bedShape }: { plate: PlateState } & BedProps) {
  const [expanded, setExpanded] = useState(false)
  const statsLabel = useMemo(
    () => (plate.gcode ? gcodeStatsLabel(extractGcodeStats(plate.gcode)) : ''),
    [plate.gcode],
  )

  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border overflow-hidden',
        plate.slicing ? 'border-orca-200'
          : plate.error ? 'border-red-200'
          : plate.stale ? 'border-amber-200'
          : 'border-green-200',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-slate-50">
          {plate.slicing && <SpinnerIcon className="w-5 h-5 text-orca-500 animate-spin" />}
          {!plate.slicing && plate.error && <ErrorCircleIcon className="w-5 h-5 text-red-400" />}
          {!plate.slicing && plate.gcode && (
            <CheckCircleIcon className={clsx('w-5 h-5', plate.stale ? 'text-amber-500' : 'text-green-500')} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800">Plate G-code</p>
          <p className={clsx('text-xs', {
            'text-orca-600': plate.slicing,
            'text-red-500': !!plate.error,
            'text-amber-600': !plate.slicing && !!plate.gcode && plate.stale,
            'text-green-600': !plate.slicing && !!plate.gcode && !plate.stale,
          })}>
            {plate.slicing && <SlicingLabel />}
            {!plate.slicing && plate.error}
            {!plate.slicing && plate.gcode && (
              plate.stale
                ? 'Sliced with previous settings — use "One plate" again to apply changes'
                : (statsLabel ? `Done · ${statsLabel}` : 'Done')
            )}
          </p>
        </div>
        {plate.gcode && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded(e => !e)}
              title="Preview G-code"
              className="text-slate-300 hover:text-slate-600 transition-colors p-1"
            >
              <EyeIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => downloadGcode(plate.gcode!, 'plate.gcode')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors"
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
          </div>
        )}
      </div>

      {expanded && plate.gcode && (
        <div className="border-t border-slate-100 bg-slate-900" style={{ height: 300 }}>
          <GcodeViewer gcode={plate.gcode} bedX={bedX} bedY={bedY} bedShape={bedShape} />
        </div>
      )}
    </div>
  )
}

// ── Config summary ────────────────────────────────────────────────────────────

export function ConfigSummary({ config, fileCount }: { config: OrcaConfig; fileCount: number }) {
  const filamentEntries = String(config.filament_type ?? DISPLAY_DEFAULTS.filament_type)
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const filamentTypes = [...new Set(filamentEntries)]
  const material = filamentEntries.length > 1
    ? `${filamentTypes.join(' / ')} (${filamentEntries.length} slots)`
    : (filamentTypes[0] ?? DISPLAY_DEFAULTS.filament_type)
  const rows: [string, string][] = [
    ['Files', `${fileCount} file${fileCount !== 1 ? 's' : ''}`],
    ['Printer', config.printer_model ?? DISPLAY_DEFAULTS.printer_model],
    ['Material', material],
    ['Layer height', `${config.layer_height ?? DISPLAY_DEFAULTS.layer_height} mm`],
    ['Infill', `${config.sparse_infill_density ?? DISPLAY_DEFAULTS.sparse_infill_density}% ${config.sparse_infill_pattern ?? DISPLAY_DEFAULTS.sparse_infill_pattern}`],
    ['Walls', String(config.wall_loops ?? DISPLAY_DEFAULTS.wall_loops)],
    ['Wall generator', config.wall_generator ?? DISPLAY_DEFAULTS.wall_generator],
    ['Nozzle temp', `${config.nozzle_temperature ?? DISPLAY_DEFAULTS.nozzle_temperature}°C`],
    ['Supports', config.enable_support ? (config.support_type ?? DISPLAY_DEFAULTS.support_type) : 'none'],
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

// ── Shared bits ───────────────────────────────────────────────────────────────

function SlicingLabel() {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(id)
  }, [])
  return <>Slicing… ({elapsed}s)</>
}
