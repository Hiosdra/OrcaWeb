import clsx from 'clsx'
import { strToU8, zipSync } from 'fflate'
import { useEffect, useMemo, useState } from 'react'
import type { PlateState } from '../hooks/useSliceQueue'
import { downloadBlob } from '../lib/download'
import { extractGcodeStats, gcodeStatsLabel } from '../lib/gcode-stats'
import { DISPLAY_DEFAULTS, filamentSlots } from '../lib/profiles'
import type { WasmStatus } from '../lib/worker-singleton'
import type { OrcaConfig, QueueItem } from '../types'
import { GcodeViewer } from './GcodeViewer'
import {
  CheckCircleIcon,
  ClockIcon,
  DownloadIcon,
  ErrorCircleIcon,
  EyeIcon,
  PlateIcon,
  SliceIcon,
  SpinnerIcon,
  XIcon,
} from './icons'
import { ModelViewer } from './ModelViewer'
import { ViewerErrorBoundary } from './ViewerErrorBoundary'

interface BedProps {
  bedX: number
  bedY: number
  bedShape: 'rectangle' | 'circle'
}

// ── Download helpers ──────────────────────────────────────────────────────────

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
  const readyCount = queue.filter((i) => i.status === 'ready').length
  const staleCount = queue.filter((i) => i.status === 'done' && i.stale).length
  const doneCount = queue.filter((i) => i.status === 'done').length
  const errorCount = queue.filter((i) => i.status === 'error').length
  const busyCount = queue.filter((i) => i.status === 'slicing').length
  const isSlicing = busyCount > 0
  const sliceableCount = readyCount + staleCount

  const readyForPlate = queue.filter((i) => i.status === 'ready' && i.stlFile != null).length
  const allDone = totalCount > 0 && doneCount + errorCount === totalCount && staleCount === 0
  const canSlice = sliceableCount > 0 && !isSlicing && !plate.slicing
  // No wasmStatus gate here, matching canSlice: doSliceMulti() buffers the
  // request in pendingPlate exactly like doSlice() buffers pendingSlice while
  // the engine is still loading (slicer.worker.ts), so there's no need to
  // block the click — it would just needlessly make users wait for the
  // engine before they can even queue a plate slice.
  const canPlate = readyForPlate >= 2 && !isSlicing && !plate.slicing

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
        type="button"
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
          type="button"
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
          type="button"
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
          type="button"
          onClick={() => downloadAllAsZip(queue)}
          className="flex items-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm bg-green-600 hover:bg-green-700 text-white transition-colors"
        >
          <DownloadIcon className="w-4 h-4" />
          Download All (.zip)
        </button>
      )}

      {/* orc_slice_multi drops the whole per-object extruder mapping unless
          every file loaded as exactly one object (slicer.cpp's
          can_map_extruders), and the bridge has no channel to report that
          back — so surface the condition up front rather than let the
          assignment silently do nothing. */}
      {queue.some((i) => i.extruderId) && (
        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Filament slots apply only if each file contains a single object
        </span>
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
  item,
  bedX,
  bedY,
  bedShape,
  onExport3mf,
  filamentSlotCount,
  onSetExtruderId,
}: {
  item: QueueItem
  onExport3mf: (item: QueueItem) => Promise<ArrayBuffer>
  /** Number of AMS-style filament slots in the current filament_type — the
   *  slot picker below only makes sense (and is only shown) when there's
   *  more than one to choose from. See filamentSlots() in lib/profiles.ts. */
  filamentSlotCount: number
  onSetExtruderId: (id: string, extruderId: number | undefined) => void
} & BedProps) {
  const [expanded, setExpanded] = useState(false)
  const [exporting3mf, setExporting3mf] = useState(false)
  const [export3mfError, setExport3mfError] = useState<string | null>(null)
  const statsLabel = useMemo(() => (item.gcode ? gcodeStatsLabel(extractGcodeStats(item.gcode)) : ''), [item.gcode])
  // Stable array reference so ModelViewer's effect doesn't recreate the
  // WebGL scene on every unrelated re-render while the card is expanded.
  const previewFiles = useMemo(() => (item.stlFile ? [item.stlFile] : []), [item.stlFile])

  const handleExport3mf = async () => {
    setExporting3mf(true)
    setExport3mfError(null)
    try {
      const data = await onExport3mf(item)
      const name = `${item.name.replace(/\.\w+$/, '')}.3mf`
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
          ? item.stale
            ? 'border-amber-200'
            : 'border-green-200'
          : item.status === 'error'
            ? 'border-red-200'
            : 'border-slate-200',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg">
          {item.status === 'converting' && <SpinnerIcon className="w-5 h-5 text-amber-500 animate-spin" />}
          {item.status === 'ready' && <ClockIcon className="w-5 h-5 text-slate-400" />}
          {item.status === 'slicing' && <SpinnerIcon className="w-5 h-5 text-orca-500 animate-spin" />}
          {item.status === 'done' && (
            <CheckCircleIcon className={clsx('w-5 h-5', item.stale ? 'text-amber-500' : 'text-green-500')} />
          )}
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
            {item.status === 'slicing' && <SlicingLabel progress={item.progress} />}
            {item.status === 'done' &&
              (item.stale
                ? 'Sliced with previous settings — re-slice to apply changes'
                : statsLabel
                  ? `Done · ${statsLabel}`
                  : 'Done')}
            {item.status === 'error' && (item.error ?? 'Error')}
          </p>
        </div>

        {/* Only relevant while the item is 'ready' — slicePlate() reads
            extruderId off exactly that filter, so showing this for a
            'done'/'error' item would let a choice silently have no effect
            until the item is re-queued (via a re-slice) and picked up again. */}
        {filamentSlotCount > 1 && item.status === 'ready' && (
          <select
            value={item.extruderId ?? 0}
            onChange={(e) => onSetExtruderId(item.id, Number(e.target.value) || undefined)}
            title={
              'Filament slot to use when slicing this file as part of a One-plate multi-material slice.\n' +
              'Applies only if the file loads as exactly one object — a file containing several ' +
              'separate solids falls back to the default slot.'
            }
            className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 focus:outline-none focus:ring-2 focus:ring-orca-400"
          >
            <option value={0}>Default slot</option>
            {Array.from({ length: filamentSlotCount }, (_, i) => i + 1).map((slot) => (
              <option key={slot} value={slot}>
                Slot {slot}
              </option>
            ))}
          </select>
        )}

        {item.status === 'done' && item.gcode && item.gcodeFilename && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              title="Preview G-code"
              className="text-slate-300 hover:text-slate-600 transition-colors p-1"
            >
              <EyeIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => downloadGcode(item.gcode!, item.gcodeFilename!)}
              data-testid="download-gcode-button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors"
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
            <button
              type="button"
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
              {exporting3mf ? (
                <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <DownloadIcon className="w-3.5 h-3.5" />
              )}
              {exporting3mf ? 'Exporting…' : item.stale ? '.3mf*' : '.3mf'}
            </button>
          </div>
        )}
      </div>

      {item.status === 'slicing' && item.progress && (
        <div
          role="progressbar"
          aria-valuenow={item.progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Slicing progress: ${item.progress.percent}%`}
          className="h-1 bg-slate-100"
        >
          <div
            className="h-full bg-orca-500 transition-[width] duration-200"
            style={{ width: `${item.progress.percent}%` }}
          />
        </div>
      )}

      {export3mfError && (
        <div className="px-4 pb-3 -mt-1 text-xs text-red-500">3MF export failed: {export3mfError}</div>
      )}

      {expanded && item.stlFile && item.gcode && (
        <div className="border-t border-slate-100">
          <div className="grid sm:grid-cols-2" style={{ height: 300 }}>
            <div className="border-r border-slate-100">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Model</div>
              <div style={{ height: 270 }}>
                <ViewerErrorBoundary key={item.id} message="3D preview unavailable">
                  <ModelViewer files={previewFiles} bedX={bedX} bedY={bedY} bedShape={bedShape} />
                </ViewerErrorBoundary>
              </div>
            </div>
            <div className="bg-slate-900">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                G-code
              </div>
              <div style={{ height: 270 }}>
                <ViewerErrorBoundary key={`${item.id}-${item.gcode}`} message="G-code preview unavailable">
                  <GcodeViewer gcode={item.gcode} bedX={bedX} bedY={bedY} bedShape={bedShape} />
                </ViewerErrorBoundary>
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
  const statsLabel = useMemo(() => (plate.gcode ? gcodeStatsLabel(extractGcodeStats(plate.gcode)) : ''), [plate.gcode])

  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border overflow-hidden',
        plate.slicing
          ? 'border-orca-200'
          : plate.error
            ? 'border-red-200'
            : plate.stale
              ? 'border-amber-200'
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
          <p
            className={clsx('text-xs', {
              'text-orca-600': plate.slicing,
              'text-red-500': !!plate.error,
              'text-amber-600': !plate.slicing && !!plate.gcode && plate.stale,
              'text-green-600': !plate.slicing && !!plate.gcode && !plate.stale,
            })}
          >
            {plate.slicing && <SlicingLabel progress={plate.progress} />}
            {!plate.slicing && plate.error}
            {!plate.slicing &&
              plate.gcode &&
              (plate.stale
                ? 'Sliced with previous settings — use "One plate" again to apply changes'
                : statsLabel
                  ? `Done · ${statsLabel}`
                  : 'Done')}
          </p>
        </div>
        {plate.gcode && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              title="Preview G-code"
              className="text-slate-300 hover:text-slate-600 transition-colors p-1"
            >
              <EyeIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => downloadGcode(plate.gcode!, 'plate.gcode')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-colors"
            >
              <DownloadIcon className="w-3.5 h-3.5" />
              Download
            </button>
          </div>
        )}
      </div>

      {plate.slicing && plate.progress && (
        <div
          role="progressbar"
          aria-valuenow={plate.progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Plate slicing progress: ${plate.progress.percent}%`}
          className="h-1 bg-slate-100"
        >
          <div
            className="h-full bg-orca-500 transition-[width] duration-200"
            style={{ width: `${plate.progress.percent}%` }}
          />
        </div>
      )}

      {expanded && plate.gcode && (
        <div className="border-t border-slate-100 bg-slate-900" style={{ height: 300 }}>
          <ViewerErrorBoundary key={plate.gcode} message="G-code preview unavailable">
            <GcodeViewer gcode={plate.gcode} bedX={bedX} bedY={bedY} bedShape={bedShape} />
          </ViewerErrorBoundary>
        </div>
      )}
    </div>
  )
}

// ── Config summary ────────────────────────────────────────────────────────────

export function ConfigSummary({ config, fileCount }: { config: OrcaConfig; fileCount: number }) {
  const filamentEntries = filamentSlots(config)
  const filamentTypes = [...new Set(filamentEntries)]
  const material =
    filamentEntries.length > 1
      ? `${filamentTypes.join(' / ')} (${filamentEntries.length} slots)`
      : (filamentTypes[0] ?? DISPLAY_DEFAULTS.filament_type)
  const rows: [string, string][] = [
    ['Files', `${fileCount} file${fileCount !== 1 ? 's' : ''}`],
    ['Printer', config.printer_model ?? DISPLAY_DEFAULTS.printer_model],
    ['Nozzle', `${config.nozzle_diameter ?? DISPLAY_DEFAULTS.nozzle_diameter} mm`],
    ['Material', material],
    ['Layer height', `${config.layer_height ?? DISPLAY_DEFAULTS.layer_height} mm`],
    [
      'Infill',
      `${config.sparse_infill_density ?? DISPLAY_DEFAULTS.sparse_infill_density}% ${config.sparse_infill_pattern ?? DISPLAY_DEFAULTS.sparse_infill_pattern}`,
    ],
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

function SlicingLabel({ progress }: { progress?: { percent: number; stage: string } }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250)
    return () => clearInterval(id)
  }, [])
  return progress ? (
    <>
      {progress.stage || 'Slicing…'} ({progress.percent}%) · {elapsed}s
    </>
  ) : (
    <>Slicing… ({elapsed}s)</>
  )
}
