import clsx from 'clsx'
import { useRef, useState } from 'react'
import { FILAMENT_PRESETS, PRESETS, PRINTER_PRESETS, parseOrcaProfileJson } from '../lib/profiles'
import type { FuzzySkin, InfillPattern, OrcaConfig, SeamPosition, SupportType, WallGenerator } from '../types'
import { ChevronIcon, UploadIcon } from './icons'

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
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  return (
    <div className="space-y-6">
      {/* Profile import */}
      <div>
        <input
          ref={fileInputRef}
          data-testid="profile-file-input"
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleProfileFile}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-orca-400 hover:text-orca-600 hover:bg-orca-50 transition-all"
        >
          <UploadIcon className="w-4 h-4" />
          Import OrcaSlicer profile (.json)
        </button>
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
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Density: {config.sparse_infill_density ?? 15}%
            </label>
            <input
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
        <div className="mt-3">
          <NumberField
            label="Brim width"
            unit="mm"
            value={config.brim_width ?? 0}
            min={0}
            max={30}
            step={1}
            onChange={(v) => onChange({ brim_width: v })}
          />
        </div>
      </Section>

      {/* Advanced toggle */}
      <button
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
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <select
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

  const commit = (raw: string) => {
    setDraft(null)
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
  }

  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <div className="flex items-center gap-1">
        <input
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
    <button onClick={() => onChange(!value)} className={clsx('flex items-center justify-between w-full', className)}>
      <span className="text-sm text-slate-700">{label}</span>
      <div className={clsx('relative w-10 h-5 rounded-full transition-colors', value ? 'bg-orca-500' : 'bg-slate-200')}>
        <div
          className={clsx(
            'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </div>
    </button>
  )
}
