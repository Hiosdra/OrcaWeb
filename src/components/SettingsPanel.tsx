import clsx from 'clsx'
import { strToU8, zipSync } from 'fflate'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { type ConfigField, overriddenFields } from '../lib/config-layers'
import { downloadBlob } from '../lib/download'
import {
  DISPLAY_DEFAULTS,
  describeExportCompatibility,
  exportOrcaProfileBundle,
  FILAMENT_PRESETS,
  MAX_FILAMENT_SLOTS,
  PRESETS,
  PRIME_TOWER_DEFAULT_ENABLED,
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

/**
 * Which fields the user has edited by hand, and how to undo one — supplied
 * by App from the manual override layer (see lib/config-layers.ts). Passed
 * through context rather than as a prop per control: every field primitive
 * below needs it, they nest several levels deep, and the alternative is
 * threading the same two values through ~30 call sites by hand.
 */
interface OverrideState {
  isOverridden: (field: ConfigField) => boolean
  revert: (field: ConfigField) => void
}

const OverrideContext = createContext<OverrideState>({ isOverridden: () => false, revert: () => {} })

/**
 * Marks a control as carrying a manual override: an amber ring plus a revert
 * button, mirroring how desktop OrcaSlicer flags a modified setting. `field`
 * is what ties a control to its config key — a control without one (the
 * printer/filament pickers, which select a preset rather than set a field)
 * is never marked.
 *
 * Takes the state explicitly rather than reading the context itself, because
 * SettingsPanel — which *provides* the context — has one inline control of
 * its own to mark (the infill slider), and a useContext() call inside the
 * provider component would read the default value, not the provided one.
 */
function overrideMarker({ isOverridden, revert }: OverrideState, field?: ConfigField) {
  const overridden = field !== undefined && isOverridden(field)
  return {
    overridden,
    // Same ring the focus state uses, so an overridden field reads as
    // "touched" at a glance without shouting over the rest of the panel.
    inputClass: overridden ? 'border-amber-400 ring-1 ring-amber-300' : 'border-slate-200',
    revertButton:
      overridden && field !== undefined ? (
        <button
          type="button"
          onClick={() => revert(field)}
          title="Revert to the value from the selected profile"
          data-testid={`revert-${field}`}
          className="shrink-0 rounded px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 hover:bg-amber-50"
        >
          reset
        </button>
      ) : null,
  }
}

/** The same marker, for the field primitives that live under the provider. */
function useOverride(field?: ConfigField) {
  return overrideMarker(useContext(OverrideContext), field)
}

// Controls that are present while the panel is in its default (non-advanced)
// state. The summary uses this list to keep a reset action reachable even when
// an overridden control is currently hidden behind a toggle or the advanced
// section.
const BASIC_SETTING_FIELDS: ConfigField[] = [
  'nozzle_diameter',
  'nozzle_temperature',
  'bed_temperature',
  'layer_height',
  'wall_loops',
  'initial_layer_print_height',
  'top_shell_layers',
  'bottom_shell_layers',
  'wall_generator',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'enable_support',
  'brim_width',
  'brim_type',
  'raft_layers',
  'skirt_loops',
  'skirt_distance',
]

const ADVANCED_SETTING_FIELDS: ConfigField[] = [
  'default_speed',
  'outer_wall_speed',
  'initial_layer_speed',
  'travel_speed',
  'seam_position',
  'fuzzy_skin',
  'fuzzy_skin_thickness',
  'fuzzy_skin_point_dist',
  'enable_ironing',
]

const OVERRIDE_LABELS: Partial<Record<ConfigField, string>> = {
  support_type: 'Support type',
  fuzzy_skin_thickness: 'Fuzzy skin thickness',
  fuzzy_skin_point_dist: 'Fuzzy skin point distance',
  enable_prime_tower: 'Prime tower',
  prime_tower_width: 'Prime tower width',
}

function overrideLabel(field: ConfigField): string {
  return OVERRIDE_LABELS[field] ?? String(field).replace(/_/g, ' ')
}

/**
 * What a newly added slot starts out as: the first material not already in
 * use. Repeating the last one gives two slots the engine will happily purge
 * 280 mm³ between for no reason, and two identically-labelled entries in the
 * queue's per-object picker. Falls back to repeating once every material is
 * already assigned to some slot.
 */
function nextSlotMaterial(slots: string[]): string {
  const options = Object.keys(FILAMENT_PRESETS)
  return options.find((o) => !slots.includes(o)) ?? slots[slots.length - 1]
}

interface Props {
  config: OrcaConfig
  onChange: (patch: Partial<OrcaConfig>) => void
  /** The manual override layer — the fields to flag as edited. */
  overrides: Partial<OrcaConfig>
  onRevertField: (field: ConfigField) => void
  onRevertAll: () => void
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
  /** One entry per filament slot; slot 0 drives the panel's scalar fields. */
  selectedFilaments: string[]
  onFilamentsChange: (names: string[]) => void
  userPresets: UserPreset[]
  onSaveUserPreset: (name: string) => void
  onLoadUserPreset: (id: string) => void
  onDeleteUserPreset: (id: string) => void
}

export function SettingsPanel({
  config,
  onChange,
  overrides,
  onRevertField,
  onRevertAll,
  onProfileImport,
  activeImport,
  onRemoveImport,
  selectedPreset,
  onPresetChange,
  selectedPrinter,
  importedPrinterLabel,
  onPrinterChange,
  selectedFilaments,
  onFilamentsChange,
  userPresets,
  onSaveUserPreset,
  onLoadUserPreset,
  onDeleteUserPreset,
}: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  // Shared by the import and export buttons — both report their outcome in
  // the same line under that row.
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const densityId = useId()
  const [savingPresetName, setSavingPresetName] = useState<string | null>(null)

  const overriddenKeys = overriddenFields(overrides)
  const overrideContext = useMemo(
    () => ({
      isOverridden: (field: ConfigField) => field in overrides,
      revert: onRevertField,
    }),
    [overrides, onRevertField],
  )
  const densityOverride = overrideMarker(overrideContext, 'sparse_infill_density')
  const visibleOverrideFields = new Set<ConfigField>(BASIC_SETTING_FIELDS)
  if (showAdvanced) {
    const fuzzySkinEnabled = (config.fuzzy_skin ?? DISPLAY_DEFAULTS.fuzzy_skin) !== 'none'
    for (const field of ADVANCED_SETTING_FIELDS) {
      if (!fuzzySkinEnabled && (field === 'fuzzy_skin_thickness' || field === 'fuzzy_skin_point_dist')) continue
      visibleOverrideFields.add(field)
    }
  }
  if (config.enable_support) visibleOverrideFields.add('support_type')
  // The prime tower defaults on for a multi-slot config (see #163); an explicit
  // toggle still wins. Drives both the control's rendered state and which of its
  // override markers count as visible.
  const primeTowerOn = config.enable_prime_tower ?? PRIME_TOWER_DEFAULT_ENABLED
  // The prime-tower controls only render for a multi-slot config (see the
  // Filament section); the width sub-field only while the tower is on.
  if (selectedFilaments.length > 1) {
    visibleOverrideFields.add('enable_prime_tower')
    if (primeTowerOn) visibleOverrideFields.add('prime_tower_width')
  }
  const hiddenOverrideKeys = overriddenKeys.filter((field) => !visibleOverrideFields.has(field))

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
          setNotice({ ok: false, text: 'No recognised settings found in this JSON.' })
        } else {
          const rawType = parsed?.type
          const profileType =
            rawType === 'machine' || rawType === 'filament' || rawType === 'process' ? rawType : 'print'
          const profileName = typeof parsed?.name === 'string' ? parsed.name : null
          const label = profileName ? `"${profileName}"` : `"${file.name}"`
          onProfileImport({ name: profileName ?? file.name, type: profileType, settings: patch })
          setNotice({ ok: true, text: `Imported ${label} · ${profileType} profile · ${total} settings` })
        }
      } catch {
        setNotice({ ok: false, text: 'Invalid JSON file.' })
      }
      setTimeout(() => setNotice(null), 4000)
    }
    reader.readAsText(file)
  }

  // Real OrcaSlicer presets are separate files (print/filament/printer) — a
  // single flat JSON can't represent them at once, and a multi-material config
  // needs one filament file per slot (see exportOrcaProfileBundle's doc
  // comment) — so the export is a small zip bundling them all, matching the
  // multi-file zip download already used for G-code exports in SliceCards.tsx.
  function handleExportProfile() {
    const name = `OrcaWeb — ${selectedPrinter} / ${selectedFilaments.join('+')} / ${selectedPreset}`
    const files = exportOrcaProfileBundle(config, name)
    const zipped = zipSync(Object.fromEntries(files.map((f) => [f.filename, strToU8(f.json)])))
    downloadBlob(new Blob([zipped], { type: 'application/zip' }), 'orcaweb-settings.zip')

    // The download always happens; this only reports whether desktop
    // OrcaSlicer will actually accept the result (see
    // describeExportCompatibility).
    const problem = describeExportCompatibility(config)
    setNotice(
      problem
        ? { ok: false, text: problem }
        : { ok: true, text: `Exported ${files.length} preset files as orcaweb-settings.zip` },
    )
    setTimeout(() => setNotice(null), problem ? 12000 : 4000)
  }

  function handleConfirmSavePreset() {
    const name = savingPresetName?.trim()
    if (!name) return
    onSaveUserPreset(name)
    setSavingPresetName(null)
  }

  return (
    <OverrideContext.Provider value={overrideContext}>
      <div className="space-y-6">
        {/* Manual overrides — what survives every profile change below it */}
        {overriddenKeys.length > 0 && (
          <div
            data-testid="override-summary"
            className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
          >
            <div className="min-w-0 flex-1">
              <div>
                {overriddenKeys.length} setting{overriddenKeys.length === 1 ? '' : 's'} changed by you · kept when you
                switch printer, filament, preset or load another file
              </div>
              {hiddenOverrideKeys.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="mr-1">Hidden settings:</span>
                  {hiddenOverrideKeys.map((field) => (
                    <button
                      type="button"
                      key={field}
                      onClick={() => onRevertField(field)}
                      title={`Revert ${overrideLabel(field)} to the value from the selected profile`}
                      data-testid={`revert-${field}`}
                      className="rounded px-1 font-semibold hover:bg-amber-100"
                    >
                      {overrideLabel(field)} reset
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onRevertAll}
              data-testid="reset-all-overrides"
              className="shrink-0 rounded px-1 font-semibold hover:bg-amber-100"
            >
              Reset all
            </button>
          </div>
        )}

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
              title="Save the current settings as an OrcaSlicer-compatible preset bundle (print/filament/printer .json, one filament file per slot, zipped)"
              data-testid="export-profile-button"
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-orca-400 hover:text-orca-600 hover:bg-orca-50 transition-all"
            >
              <DownloadIcon className="w-4 h-4" />
              Export (.zip)
            </button>
          </div>
          {notice && (
            <p
              data-testid="settings-notice"
              className={clsx('mt-1.5 text-xs px-2', notice.ok ? 'text-green-600' : 'text-red-500')}
            >
              {notice.ok ? '✓ ' : '✗ '}
              {notice.text}
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
              field="nozzle_diameter"
              unit="mm"
              value={config.nozzle_diameter ?? DISPLAY_DEFAULTS.nozzle_diameter}
              min={0.1}
              max={1.2}
              step={0.05}
              onChange={(v) => onChange({ nozzle_diameter: v })}
            />
          </div>
        </Section>

        {/* Filament */}
        <Section title="Filament">
          {selectedFilaments.map((slot, i) => (
            // Slots are a positional list — index IS the identity, and the
            // engine indexes its per-filament arrays the same way.
            // biome-ignore lint/suspicious/noArrayIndexKey: slot index is the identity
            <div key={i} className="flex items-end gap-2 mb-2">
              <SelectField
                className="flex-1"
                label={selectedFilaments.length > 1 ? `Slot ${i + 1}` : 'Material'}
                value={slot}
                options={Object.keys(FILAMENT_PRESETS)}
                onChange={(v) => onFilamentsChange(selectedFilaments.map((s, j) => (j === i ? v : s)))}
              />
              {selectedFilaments.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove filament slot ${i + 1}`}
                  onClick={() => onFilamentsChange(selectedFilaments.filter((_, j) => j !== i))}
                  className="mb-1 px-2 py-1.5 rounded-lg border border-slate-200 text-slate-400 hover:border-red-300 hover:text-red-500 transition-colors"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
          {selectedFilaments.length < MAX_FILAMENT_SLOTS && (
            <button
              type="button"
              onClick={() => onFilamentsChange([...selectedFilaments, nextSlotMaterial(selectedFilaments)])}
              data-testid="add-filament-slot"
              className="text-xs font-semibold text-orca-600 hover:text-orca-700 transition-colors"
            >
              + Add filament slot
            </button>
          )}
          {selectedFilaments.length > 1 && (
            <>
              <p className="mt-2 text-xs text-slate-400">
                Assign objects to slots on the Slice tab. Multiple slots make each plate slice a multi-material print.
              </p>
              {/* The prime (wipe) tower is where each tool change deposits its
                  purged filament — a multi-material plate needs one, so it is
                  on by default (see PRIME_TOWER_DEFAULT_ENABLED / #163). Only
                  shown here because it is meaningless with a single slot. */}
              <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
                <ToggleField
                  label="Prime tower"
                  field="enable_prime_tower"
                  value={primeTowerOn}
                  onChange={(v) => onChange({ enable_prime_tower: v })}
                />
                {primeTowerOn && (
                  <div className="mt-3">
                    <NumberField
                      label="Tower width"
                      field="prime_tower_width"
                      unit="mm"
                      value={config.prime_tower_width ?? DISPLAY_DEFAULTS.prime_tower_width}
                      min={10}
                      max={100}
                      step={5}
                      onChange={(v) => onChange({ prime_tower_width: v })}
                    />
                  </div>
                )}
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3 mt-3">
            <NumberField
              label="Nozzle temp"
              field="nozzle_temperature"
              unit="°C"
              value={config.nozzle_temperature ?? DISPLAY_DEFAULTS.nozzle_temperature}
              min={150}
              max={350}
              step={5}
              onChange={(v) => onChange({ nozzle_temperature: v })}
            />
            <NumberField
              label="Bed temp"
              field="bed_temperature"
              unit="°C"
              value={config.bed_temperature ?? DISPLAY_DEFAULTS.bed_temperature}
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
              field="layer_height"
              unit="mm"
              value={config.layer_height ?? DISPLAY_DEFAULTS.layer_height}
              min={0.05}
              max={0.5}
              step={0.05}
              onChange={(v) => onChange({ layer_height: v })}
            />
            <NumberField
              label="Walls"
              field="wall_loops"
              unit="loops"
              value={config.wall_loops ?? DISPLAY_DEFAULTS.wall_loops}
              min={1}
              max={10}
              step={1}
              onChange={(v) => onChange({ wall_loops: v })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <NumberField
              label="First layer height"
              field="initial_layer_print_height"
              unit="mm"
              value={
                config.initial_layer_print_height ?? config.layer_height ?? DISPLAY_DEFAULTS.initial_layer_print_height
              }
              min={0.05}
              max={0.5}
              step={0.05}
              onChange={(v) => onChange({ initial_layer_print_height: v })}
            />
            <NumberField
              label="Top shells"
              field="top_shell_layers"
              unit="layers"
              value={config.top_shell_layers ?? DISPLAY_DEFAULTS.top_shell_layers}
              min={0}
              max={20}
              step={1}
              onChange={(v) => onChange({ top_shell_layers: v })}
            />
            <NumberField
              label="Bottom shells"
              field="bottom_shell_layers"
              unit="layers"
              value={config.bottom_shell_layers ?? DISPLAY_DEFAULTS.bottom_shell_layers}
              min={0}
              max={20}
              step={1}
              onChange={(v) => onChange({ bottom_shell_layers: v })}
            />
          </div>
          <SelectField
            label="Wall generator"
            field="wall_generator"
            value={config.wall_generator ?? DISPLAY_DEFAULTS.wall_generator}
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
              {/* A range input has no border to tint, so the override marker
                rides on the label instead. */}
              <div className="flex items-center justify-between gap-1 mb-1">
                <label
                  htmlFor={densityId}
                  className={clsx(
                    'block text-xs font-medium',
                    densityOverride.overridden ? 'text-amber-700' : 'text-slate-600',
                  )}
                >
                  Density: {config.sparse_infill_density ?? DISPLAY_DEFAULTS.sparse_infill_density}%
                </label>
                {densityOverride.revertButton}
              </div>
              <input
                id={densityId}
                type="range"
                min={0}
                max={100}
                step={5}
                value={config.sparse_infill_density ?? DISPLAY_DEFAULTS.sparse_infill_density}
                onChange={(e) => onChange({ sparse_infill_density: Number(e.target.value) })}
                className={clsx('w-full', densityOverride.overridden ? 'accent-amber-500' : 'accent-orca-500')}
              />
            </div>
          </div>
          <SelectField
            label="Pattern"
            field="sparse_infill_pattern"
            value={config.sparse_infill_pattern ?? DISPLAY_DEFAULTS.sparse_infill_pattern}
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
            field="enable_support"
            value={config.enable_support ?? DISPLAY_DEFAULTS.enable_support}
            onChange={(v) => onChange({ enable_support: v })}
          />
          {config.enable_support && (
            <SelectField
              label="Support type"
              field="support_type"
              value={config.support_type ?? DISPLAY_DEFAULTS.support_type}
              options={['normal(auto)', 'normal(manual)', 'tree(auto)', 'tree(manual)'] as SupportType[]}
              onChange={(v) => onChange({ support_type: v as SupportType })}
              className="mt-3"
            />
          )}
          <div className="grid grid-cols-2 gap-3 mt-3">
            <NumberField
              label="Brim width"
              field="brim_width"
              unit="mm"
              value={config.brim_width ?? DISPLAY_DEFAULTS.brim_width}
              min={0}
              max={30}
              step={1}
              onChange={(v) => onChange({ brim_width: v })}
            />
            <SelectField
              label="Brim type"
              field="brim_type"
              value={config.brim_type ?? DISPLAY_DEFAULTS.brim_type}
              options={['auto_brim', 'no_brim', 'outer_only', 'inner_only', 'outer_and_inner'] as BrimType[]}
              onChange={(v) => onChange({ brim_type: v as BrimType })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <NumberField
              label="Raft layers"
              field="raft_layers"
              unit="layers"
              value={config.raft_layers ?? DISPLAY_DEFAULTS.raft_layers}
              min={0}
              max={100}
              step={1}
              onChange={(v) => onChange({ raft_layers: v })}
            />
            <NumberField
              label="Skirt loops"
              field="skirt_loops"
              unit="loops"
              value={config.skirt_loops ?? DISPLAY_DEFAULTS.skirt_loops}
              min={0}
              max={10}
              step={1}
              onChange={(v) => onChange({ skirt_loops: v })}
            />
            <NumberField
              label="Skirt distance"
              field="skirt_distance"
              unit="mm"
              value={config.skirt_distance ?? DISPLAY_DEFAULTS.skirt_distance}
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
                  field="default_speed"
                  unit="mm/s"
                  value={config.default_speed ?? DISPLAY_DEFAULTS.default_speed}
                  min={10}
                  max={500}
                  step={10}
                  onChange={(v) => onChange({ default_speed: v })}
                />
                <NumberField
                  label="Outer wall"
                  field="outer_wall_speed"
                  unit="mm/s"
                  value={config.outer_wall_speed ?? DISPLAY_DEFAULTS.outer_wall_speed}
                  min={10}
                  max={500}
                  step={10}
                  onChange={(v) => onChange({ outer_wall_speed: v })}
                />
                <NumberField
                  label="First layer"
                  field="initial_layer_speed"
                  unit="mm/s"
                  value={config.initial_layer_speed ?? DISPLAY_DEFAULTS.initial_layer_speed}
                  min={5}
                  max={100}
                  step={5}
                  onChange={(v) => onChange({ initial_layer_speed: v })}
                />
                <NumberField
                  label="Travel"
                  field="travel_speed"
                  unit="mm/s"
                  value={config.travel_speed ?? DISPLAY_DEFAULTS.travel_speed}
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
                field="seam_position"
                value={config.seam_position ?? DISPLAY_DEFAULTS.seam_position}
                options={['aligned', 'nearest', 'back', 'random'] as SeamPosition[]}
                onChange={(v) => onChange({ seam_position: v as SeamPosition })}
              />
              <SelectField
                label="Fuzzy skin"
                field="fuzzy_skin"
                value={config.fuzzy_skin ?? DISPLAY_DEFAULTS.fuzzy_skin}
                options={['none', 'external', 'all'] as FuzzySkin[]}
                onChange={(v) => onChange({ fuzzy_skin: v as FuzzySkin })}
                className="mt-3"
              />
              {(config.fuzzy_skin ?? DISPLAY_DEFAULTS.fuzzy_skin) !== 'none' && (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <NumberField
                    label="Thickness"
                    field="fuzzy_skin_thickness"
                    unit="mm"
                    value={config.fuzzy_skin_thickness ?? DISPLAY_DEFAULTS.fuzzy_skin_thickness}
                    min={0.05}
                    max={2}
                    step={0.05}
                    onChange={(v) => onChange({ fuzzy_skin_thickness: v })}
                  />
                  <NumberField
                    label="Point dist"
                    field="fuzzy_skin_point_dist"
                    unit="mm"
                    value={config.fuzzy_skin_point_dist ?? DISPLAY_DEFAULTS.fuzzy_skin_point_dist}
                    min={0.1}
                    max={5}
                    step={0.1}
                    onChange={(v) => onChange({ fuzzy_skin_point_dist: v })}
                  />
                </div>
              )}
              <ToggleField
                label="Ironing (top surface)"
                field="enable_ironing"
                value={config.enable_ironing ?? false}
                onChange={(v) => onChange({ enable_ironing: v })}
                className="mt-3"
              />
            </Section>
          </>
        )}
      </div>
    </OverrideContext.Provider>
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
  field,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  field?: ConfigField
  value: string
  options: string[]
  onChange: (v: string) => void
  className?: string
}) {
  const id = useId()
  const { inputClass, revertButton } = useOverride(field)
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-1 mb-1">
        <label htmlFor={id} className="block text-xs font-medium text-slate-600">
          {label}
        </label>
        {revertButton}
      </div>
      <select
        id={id}
        data-testid={field && `setting-${field}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-orca-400',
          inputClass,
        )}
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
  field,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  field?: ConfigField
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
  const { inputClass, revertButton } = useOverride(field)

  const commit = (raw: string) => {
    setDraft(null)
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
  }

  // Buffering means the input can show a value the config has never seen,
  // and blur was the only way out of that state — which is not a signal to
  // depend on. Reported twice as "I set 0 skirt loops and still got a
  // skirt", and every symptom fit: no override marker, a green (not stale)
  // result card, and the field back at its profile value on return, because
  // the panel remounts with an empty draft. The reporter had used the
  // stepper arrows, which in several browsers don't focus the input at all,
  // so no blur was ever coming; requiring Enter to make a click "count" is
  // not a reasonable thing to ask of anyone either.
  //
  // So the draft is flushed on two more occasions, held in a ref because
  // neither effect may re-run per keystroke (that would commit each one,
  // which is exactly what the buffer exists to avoid).
  const pendingRef = useRef<{ draft: string | null; commit: (raw: string) => void }>({ draft, commit })
  pendingRef.current = { draft, commit }

  // 1. The browser's own "this edit is finished" signal. For the stepper
  //    buttons, the arrow keys and the mouse wheel a native `change` fires
  //    immediately; while typing it holds off until Enter or blur — exactly
  //    the split this field wants. It has to be a real listener: React's
  //    onChange is the `input` event, which fires on every keystroke.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onNativeChange = () => pendingRef.current.commit(el.value)
    el.addEventListener('change', onNativeChange)
    return () => el.removeEventListener('change', onNativeChange)
  }, [])

  // 2. The field going away — switching to the Slice tab unmounts the whole
  //    panel, and a value still sitting in the buffer would go with it.
  useEffect(
    () => () => {
      const { draft: pending, commit: flush } = pendingRef.current
      if (pending !== null) flush(pending)
    },
    [],
  )

  return (
    <div>
      <div className="flex items-center justify-between gap-1 mb-1">
        <label htmlFor={id} className="block text-xs font-medium text-slate-600">
          {label}
        </label>
        {revertButton}
      </div>
      <div className="flex items-center gap-1">
        <input
          id={id}
          ref={inputRef}
          data-testid={field && `setting-${field}`}
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
          className={clsx(
            'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-orca-400',
            inputClass,
          )}
        />
        <span className="text-xs text-slate-400 whitespace-nowrap">{unit}</span>
      </div>
    </div>
  )
}

function ToggleField({
  label,
  field,
  value,
  onChange,
  className,
}: {
  label: string
  field?: ConfigField
  value: boolean
  onChange: (v: boolean) => void
  className?: string
}) {
  const { overridden, revertButton } = useOverride(field)
  return (
    // The whole row stays one button — clicking the label, not just the
    // switch, has always toggled it. The revert control has to sit outside
    // that button (buttons can't nest), which is why this is a wrapper
    // rather than the button itself carrying `className`.
    <div className={clsx('flex items-center gap-2 w-full', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        data-testid={field && `setting-${field}`}
        onClick={() => onChange(!value)}
        className="flex flex-1 items-center justify-between gap-2 min-w-0"
      >
        <span className={clsx('text-sm text-left', overridden ? 'text-amber-700' : 'text-slate-700')}>{label}</span>
        {/* span, not div: a <button>'s content model is phrasing content only */}
        <span
          className={clsx(
            'relative inline-block shrink-0 w-10 h-5 rounded-full transition-colors',
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
      {revertButton}
    </div>
  )
}
