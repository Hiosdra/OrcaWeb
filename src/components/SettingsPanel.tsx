import clsx from 'clsx'
import { useId, useRef, useState } from 'react'
import { downloadBlob } from '../lib/download'
import {
  exportOrcaProfileJson,
  FILAMENT_PRESETS,
  PRESETS,
  PRINTER_PRESETS,
  parseOrcaProfileJson,
} from '../lib/profiles'
import type {
  BrimType,
  FuzzySkin,
  InfillPattern,
  OrcaConfig,
  SeamPosition,
  SupportType,
  UserPreset,
  WallGenerator,
} from '../types'
import { ChevronIcon, DownloadIcon, UploadIcon, XIcon } from './icons'

interface Props {
  config: OrcaConfig
  onChange: (patch: Partial<OrcaConfig>) => void
  onProfileImport: (profile: {
    name: string
    type: 'machine' | 'filament' | 'process' | 'print'
    settings: Partial<OrcaConfig>
  }) => void
  activeImport: { name: string; type: string; settingCount: number } | null
  onRemoveImport: () => void
  selectedPreset: string
  onPresetChange: (name: string) => void
  selectedPrinter: string
  importedPrinterLabel?: string
  onPrinterChange: (name: string) => void
  selectedFilament: string
  onFilamentChange: (name: string) => void
  userPresets: UserPreset[]
  onSaveUserPreset: (name: string) => void
  onLoadUserPreset: (id: string) => void
  onDeleteUserPreset: (id: string) => void
}

export function SettingsPanel({
  config,
  onChange,
  onProfileImport,
  activeImport,
  onRemoveImport,
  selectedPreset,
  onPresetChange,
  selectedPrinter,
  importedPrinterLabel,
  onPrinterChange,
  selectedFilament,
  onFilamentChange,
  userPresets,
  onSaveUserPreset,
  onLoadUserPreset,
  onDeleteUserPreset,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const densityId = useId()
  const [savingPresetName, setSavingPresetName] = useState<string | null>(null)

  function handleProfileFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const json = ev.target?.result as string
        const parsed = JSON.parse(json) as Record<string, unknown> | null
        const patch = parseOrcaProfileJson(json)
        const { _passthrough, ...knownFields } = patch
        const knownCount = Object.keys(knownFields).length
        const passthroughCount = _passthrough ? Object.keys(_passthrough).length : 0
        const total = knownCount + passthroughCount
        if (total === 0) {
          setImportMsg({ ok: false, text: 'No recognised settings found in this JSON.' })
        } else {
          const rawType = parsed?.type
          const profileType =
            rawType === 'machine' || rawType === 'filament' || rawType === 'process' ? rawType : 'print'
          const profileName = typeof parsed?.name === 'string' ? parsed.name : null
          const label = profileName ? `"${profileName}"` : `"${file.name}"`
          onProfileImport({ name: profileName ?? file.name, type: profileType, settings: patch })
          setImportMsg({ ok: true, text: `Imported ${label} · ${profileType} profile · ${total} settings` })
        }
      } catch {
        setImportMsg({ ok: false, text: 'Invalid JSON file.' })
      }
      setTimeout(() => setImportMsg(null), 4000)
    }
    reader.readAsText(file)
  }

  function handleExportProfile() {
    const name = `OrcaWeb — ${selectedPrinter} / ${selectedFilament} / ${selectedPreset}`
    const json = exportOrcaProfileJson(config, name)
    downloadBlob(new Blob([json], { type: 'application/json' }), 'orcaweb-settings.json')
  }

  function handleConfirmSavePreset() {
    const name = savingPresetName?.trim()
    if (!name) return
    onSaveUserPreset(name)
    setSavingPresetName(null)
  }

  return (
    <div className="space-y-6">
      {/* My presets */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">My presets</h3>
        {userPresets.length > 0 && (
          <div className="space-y-1.5 mb-2">
            {userPresets.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => onLoadUserPreset(p.id)}
                  title={`Load "${p.name}" (${p.printer} · ${p.filament} · ${p.preset})`}
                  className="min-w-0 flex-1 truncate text-left text-sm text-slate-700 hover:text-orca-600"
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteUserPreset(p.id)}
                  title="Delete this preset"
                  className="shrink-0 text-slate-300 hover:text-red-400 transition-colors"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        {savingPresetName === null ? (
          <button
            type="button"
            onClick={() => setSavingPresetName('')}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-orca-400 hover:text-orca-600 hover:bg-orca-50 transition-all"
          >
            Save current settings as a preset…
          </button>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={savingPresetName}
              onChange={(e) => setSavingPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmSavePreset()
                if (e.key === 'Escape') setSavingPresetName(null)
              }}
              placeholder="Preset name…"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-orca-400"
            />
            <button
              type="button"
              onClick={handleConfirmSavePreset}
              disabled={!savingPresetName.trim()}
              className="shrink-0 px-3 py-2 rounded-lg bg-orca-500 hover:bg-orca-600 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setSavingPresetName(null)}
              className="shrink-0 px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Profile import / export */}
      <div>
        <input
          ref={fileInputRef}
          data-testid="profile-file-input"
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleProfileFile}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-orca-400 hover:text-orca-600 hover:bg-orca-50 transition-all"
          >
            <UploadIcon className="w-4 h-4" />
            Import (.json)
          </button>
          <button
            type="button"
            onClick={handleExportProfile}
            title="Save the current settings as an OrcaSlicer-compatible profile"
            data-testid="export-profile-button"
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-orca-400 hover:text-orca-600 hover:bg-orca-50 transition-all"
          >
            <DownloadIcon className="w-4 h-4" />
            Export (.json)
          </button>
        </div>
        {importMsg && (
          <p className={clsx('mt-1.5 text-xs px-2', importMsg.ok ? 'text-green-600' : 'text-red-500')}>
            {importMsg.ok ? '✓ ' : '✗ '}
            {importMsg.text}
          </p>
        )}
      </div>

      {activeImport && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-orca-200 bg-orca-50 px-3 py-2 text-xs text-orca-700">
          <span className="min-w-0 truncate font-medium">
            Profile: {activeImport.name} · {activeImport.type} · {activeImport.settingCount} settings
          </span>
          <button
            type="button"
            onClick={onRemoveImport}
            title="Remove imported profile"
            className="shrink-0 rounded px-1 text-orca-600 hover:bg-orca-100 hover:text-orca-800"
          >
            ×
          </button>
        </div>
      )}

      {/* Printer */}
      <Section title="Printer">
        <SelectField
          label="Printer"
          value={importedPrinterLabel ?? selectedPrinter}
          options={
            importedPrinterLabel
              ? [...Object.keys(PRINTER_PRESETS), importedPrinterLabel]
              : Object.keys(PRINTER_PRESETS)
          }
          onChange={onPrinterChange}
        />
        <div className="mt-3">
          <NumberField
            label="Nozzle diameter"
            unit="mm"
            value={config.nozzle_diameter ?? 0.4}
            min={0.1}
            max={1.2}
            step={0.05}
            onChange={(v) => onChange({ nozzle_diameter: v })}
          />
        </div>
      </Section>

      {/* Filament */}
      <Section title="Filament">
        <SelectField
          label="Material"
          value={selectedFilament}
          options={Object.keys(FILAMENT_PRESETS)}
          onChange={onFilamentChange}
        />
        <div className="grid grid-cols-2 gap-3 mt-3">
          <NumberField
            label="Nozzle temp"
            unit="°C"
            value={config.nozzle_temperature ?? 220}
            min={150}
            max={350}
            step={5}
            onChange={(v) => onChange({ nozzle_temperature: v })}
          />
          <NumberField
            label="Bed temp"
            unit="°C"
            value={config.bed_temperature ?? 60}
            min={0}
            max={150}
            step={5}
            onChange={(v) => onChange({ bed_temperature: v })}
          />
        </div>
      </Section>

      {/* Quality preset */}
      <Section title="Quality">
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.name}
              onClick={() => onPresetChange(p.name)}
              className={clsx(
                'flex flex-col items-center gap-1 rounded-xl border-2 py-3 px-2 text-center transition-all',
                selectedPreset === p.name
                  ? 'border-orca-500 bg-orca-50 text-orca-700'
                  : 'border-slate-200 text-slate-600 hover:border-orca-300 hover:bg-orca-50',
              )}
            >
              <span className="font-semibold text-sm">{p.label}</span>
              <span className="text-xs opacity-70">{p.config.layer_height} mm</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 mt-3">
          <NumberField
            label="Layer height"
            unit="mm"
            value={config.layer_height ?? 0.2}
            min={0.05}
            max={0.5}
            step={0.05}
            onChange={(v) => onChange({ layer_height: v })}
          />
          <NumberField
            label="Walls"
            unit="loops"
            value={config.wall_loops ?? 3}
            min={1}
            max={10}
            step={1}
            onChange={(v) => onChange({ wall_loops: v })}
          />
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <NumberField
            label="First layer height"
            unit="mm"
            value={config.initial_layer_height ?? config.layer_height ?? 0.2}
            min={0.05}
            max={0.5}
            step={0.05}
            onChange={(v) => onChange({ initial_layer_height: v })}
          />
          <NumberField
            label="Top shells"
            unit="layers"
            value={config.top_shell_layers ?? 4}
            min={0}
            max={20}
            step={1}
            onChange={(v) => onChange({ top_shell_layers: v })}
          />
          <NumberField
            label="Bottom shells"
            unit="layers"
            value={config.bottom_shell_layers ?? 3}
            min={0}
            max={20}
            step={1}
            onChange={(v) => onChange({ bottom_shell_layers: v })}
          />
        </div>
        <SelectField
          label="Wall generator"
          value={config.wall_generator ?? 'arachne'}
          options={['arachne', 'classic'] as WallGenerator[]}
          onChange={(v) => onChange({ wall_generator: v as WallGenerator })}
          className="mt-3"
        />
        <p className="mt-1.5 text-xs text-slate-400 px-2">
          Arachne gives better wall quality but can take much longer (even minutes) on models with lots of small, thin
          features. Switch to Classic if a slice seems stuck.
        </p>
      </Section>

      {/* Infill */}
      <Section title="Infill">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label htmlFor={densityId} className="block text-xs font-medium text-slate-600 mb-1">
              Density: {config.sparse_infill_density ?? 15}%
            </label>
            <input
              id={densityId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={config.sparse_infill_density ?? 15}
              onChange={(e) => onChange({ sparse_infill_density: Number(e.target.value) })}
              className="w-full accent-orca-500"
            />
          </div>
        </div>
        <SelectField
          label="Pattern"
          value={config.sparse_infill_pattern ?? 'grid'}
          options={
            [
              'grid',
              'gyroid',
              'honeycomb',
              'triangles',
              'cubic',
              'lightning',
              'rectilinear',
              'crosshatch',
            ] as InfillPattern[]
          }
          onChange={(v) => onChange({ sparse_infill_pattern: v as InfillPattern })}
          className="mt-3"
        />
      </Section>

      {/* Supports */}
      <Section title="Supports & Adhesion">
        <ToggleField
          label="Enable supports"
          value={config.enable_support ?? false}
          onChange={(v) => onChange({ enable_support: v })}
        />
        {config.enable_support && (
          <SelectField
            label="Support type"
            value={config.support_type ?? 'normal(auto)'}
            options={['normal(auto)', 'normal(manual)', 'tree(auto)', 'tree(manual)'] as SupportType[]}
            onChange={(v) => onChange({ support_type: v as SupportType })}
            className="mt-3"
          />
        )}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <NumberField
            label="Brim width"
            unit="mm"
            value={config.brim_width ?? 0}
            min={0}
            max={30}
            step={1}
            onChange={(v) => onChange({ brim_width: v })}
          />
          <SelectField
            label="Brim type"
            value={config.brim_type ?? 'outer_only'}
            options={['no_brim', 'outer_only', 'inner_only', 'outer_and_inner'] as BrimType[]}
            onChange={(v) => onChange({ brim_type: v as BrimType })}
          />
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <NumberField
            label="Raft layers"
            unit="layers"
            value={config.raft_layers ?? 0}
            min={0}
            max={100}
            step={1}
            onChange={(v) => onChange({ raft_layers: v })}
          />
          <NumberField
            label="Skirt loops"
            unit="loops"
            value={config.skirt_loops ?? 0}
            min={0}
            max={10}
            step={1}
            onChange={(v) => onChange({ skirt_loops: v })}
          />
          <NumberField
            label="Skirt distance"
            unit="mm"
            value={config.skirt_distance ?? 2}
            min={0}
            max={60}
            step={1}
            onChange={(v) => onChange({ skirt_distance: v })}
          />
        </div>
      </Section>

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="w-full flex items-center justify-center gap-2 text-sm font-medium text-slate-500 hover:text-orca-600 transition-colors py-1"
      >
        <ChevronIcon open={showAdvanced} />
        {showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}
      </button>

      {showAdvanced && (
        <>
          <Section title="Speed (mm/s)">
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Default"
                unit="mm/s"
                value={config.default_speed ?? 100}
                min={10}
                max={500}
                step={10}
                onChange={(v) => onChange({ default_speed: v })}
              />
              <NumberField
                label="Outer wall"
                unit="mm/s"
                value={config.outer_wall_speed ?? 60}
                min={10}
                max={500}
                step={10}
                onChange={(v) => onChange({ outer_wall_speed: v })}
              />
              <NumberField
                label="First layer"
                unit="mm/s"
                value={config.initial_layer_speed ?? 30}
                min={5}
                max={100}
                step={5}
                onChange={(v) => onChange({ initial_layer_speed: v })}
              />
              <NumberField
                label="Travel"
                unit="mm/s"
                value={config.travel_speed ?? 150}
                min={50}
                max={1000}
                step={10}
                onChange={(v) => onChange({ travel_speed: v })}
              />
            </div>
          </Section>

          <Section title="Seam & Surface">
            <SelectField
              label="Seam position"
              value={config.seam_position ?? 'aligned'}
              options={['aligned', 'nearest', 'back', 'random'] as SeamPosition[]}
              onChange={(v) => onChange({ seam_position: v as SeamPosition })}
            />
            <SelectField
              label="Fuzzy skin"
              value={config.fuzzy_skin ?? 'none'}
              options={['none', 'external', 'all'] as FuzzySkin[]}
              onChange={(v) => onChange({ fuzzy_skin: v as FuzzySkin })}
              className="mt-3"
            />
            {(config.fuzzy_skin ?? 'none') !== 'none' && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <NumberField
                  label="Thickness"
                  unit="mm"
                  value={config.fuzzy_skin_thickness ?? 0.3}
                  min={0.05}
                  max={2}
                  step={0.05}
                  onChange={(v) => onChange({ fuzzy_skin_thickness: v })}
                />
                <NumberField
                  label="Point dist"
                  unit="mm"
                  value={config.fuzzy_skin_point_dist ?? 0.8}
                  min={0.1}
                  max={5}
                  step={0.1}
                  onChange={(v) => onChange({ fuzzy_skin_point_dist: v })}
                />
              </div>
            )}
            <ToggleField
              label="Ironing (top surface)"
              value={config.enable_ironing ?? false}
              onChange={(v) => onChange({ enable_ironing: v })}
              className="mt-3"
            />
          </Section>
        </>
      )}
    </div>
  )
}

// --- Primitive components ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">{title}</h3>
      {children}
    </div>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
  className?: string
}) {
  const id = useId()
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-orca-400"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  )
}

function NumberField({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  unit: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  // Buffer keystrokes locally and only clamp/commit on blur (or Enter).
  // Clamping on every keystroke made the field impossible to type into:
  // it couldn't be cleared, and entering "15" in a min-10 field went
  // 1 → clamped to 10 → "105".
  const [draft, setDraft] = useState<string | null>(null)
  const id = useId()

  const commit = (raw: string) => {
    setDraft(null)
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={id}
          type="number"
          value={draft ?? String(value)}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-orca-400"
        />
        <span className="text-xs text-slate-400 whitespace-nowrap">{unit}</span>
      </div>
    </div>
  )
}

function ToggleField({
  label,
  value,
  onChange,
  className,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={clsx('flex items-center justify-between w-full', className)}
    >
      <span className="text-sm text-slate-700">{label}</span>
      {/* span, not div: a <button>'s content model is phrasing content only */}
      <span
        className={clsx(
          'relative inline-block w-10 h-5 rounded-full transition-colors',
          value ? 'bg-orca-500' : 'bg-slate-200',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}
