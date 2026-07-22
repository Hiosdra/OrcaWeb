import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileUpload } from './components/FileUpload'
import { ErrorDotIcon, GithubIcon, ModelIconSm, OrcaLogo, SpinnerIcon, XIcon } from './components/icons'
import { ModelViewer } from './components/ModelViewer'
import { SettingsPanel } from './components/SettingsPanel'
import { ConfigSummary, PlateResultCard, QueueItemCard, SliceHeader } from './components/SliceCards'
import { ViewerErrorBoundary } from './components/ViewerErrorBoundary'
import { useSliceQueue } from './hooks/useSliceQueue'
import { type ConfigField, mergeConfigLayers, resolveConfig, revertField } from './lib/config-layers'
import { formatBytes } from './lib/format'
import { logWarn } from './lib/log'
import {
  buildConfig,
  DISPLAY_DEFAULTS,
  FILAMENT_PRESETS,
  filamentSlotLabels,
  PRESETS,
  PRINTER_PRESETS,
  withFilamentSlots,
} from './lib/profiles'
import type { WasmStatus } from './lib/worker-singleton'
import type { OrcaConfig, UserPreset } from './types'

// ── Persisted settings ────────────────────────────────────────────────────────

const SETTINGS_KEY = 'orcaweb.settings.v1'

interface SavedSettings {
  printer: string
  filament: string
  /** One entry per filament slot. `filament` above is the legacy single-slot
   *  field, kept so settings saved by an older build still load. */
  filaments?: string[]
  preset: string
  manualOverrides: Partial<OrcaConfig>
  importedProfile?: ImportedProfile
  overrides?: Partial<OrcaConfig>
}

type ProfileType = 'machine' | 'filament' | 'process' | 'print'

interface ImportedProfile {
  name: string
  type: ProfileType
  settings: Partial<OrcaConfig>
}

function isProfileType(value: unknown): value is ProfileType {
  return value === 'machine' || value === 'filament' || value === 'process' || value === 'print'
}

function countProfileSettings(settings: Partial<OrcaConfig>): number {
  const { _passthrough, ...known } = settings
  return Object.keys(known).length + Object.keys(_passthrough ?? {}).length
}

function loadSavedSettings(): SavedSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<SavedSettings> | null
    if (!s || typeof s !== 'object') return null
    // Validate each field against what the current app version actually
    // ships — a preset renamed between releases must not leave the UI
    // pointing at a selection that no longer exists.
    return {
      printer:
        typeof s.printer === 'string' && s.printer in PRINTER_PRESETS ? s.printer : Object.keys(PRINTER_PRESETS)[0],
      filament: typeof s.filament === 'string' && s.filament in FILAMENT_PRESETS ? s.filament : 'PLA',
      filaments: Array.isArray(s.filaments)
        ? s.filaments.filter((f): f is string => typeof f === 'string' && f in FILAMENT_PRESETS)
        : undefined,
      preset: typeof s.preset === 'string' && PRESETS.some((p) => p.name === s.preset) ? s.preset : 'standard',
      manualOverrides:
        s.manualOverrides && typeof s.manualOverrides === 'object'
          ? s.manualOverrides
          : s.overrides && typeof s.overrides === 'object'
            ? s.overrides
            : {},
      importedProfile:
        s.importedProfile &&
        typeof s.importedProfile === 'object' &&
        typeof s.importedProfile.name === 'string' &&
        isProfileType(s.importedProfile.type) &&
        s.importedProfile.settings &&
        typeof s.importedProfile.settings === 'object'
          ? (s.importedProfile as ImportedProfile)
          : undefined,
    }
  } catch (err) {
    logWarn('Failed to load saved settings — falling back to defaults', err)
    return null
  }
}

// ── User presets ──────────────────────────────────────────────────────────────
// Named, savable snapshots of a full settings selection — separate from the
// single auto-persisted "current selection" above (SETTINGS_KEY), so a user
// can keep e.g. "PETG structural" and "PLA fast draft" side by side instead
// of overwriting one working set every time they switch printer/preset.

const USER_PRESETS_KEY = 'orcaweb.userPresets.v1'

function isUserPreset(value: unknown): value is UserPreset {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<UserPreset>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.printer === 'string' &&
    // Own keys only, not `in`: the preset tables are plain objects, so `in`
    // also answers yes for "constructor"/"toString"/… — inherited names that
    // name no preset. Harmless downstream today (buildConfig spreads a
    // function to nothing), but a validator that accepts values it is meant
    // to reject is the wrong thing to leave in place. Matches how the quality
    // preset is checked against PRESETS just below; both tables are tiny.
    Object.keys(PRINTER_PRESETS).includes(p.printer) &&
    typeof p.filament === 'string' &&
    Object.keys(FILAMENT_PRESETS).includes(p.filament) &&
    // Optional — presets saved before multi-slot existed have only `filament`.
    // Present but naming a filament this build no longer ships is rejected the
    // same way `filament` itself is, rather than loading a partial slot list.
    (p.filaments === undefined ||
      (Array.isArray(p.filaments) &&
        p.filaments.length > 0 &&
        p.filaments.every((f) => typeof f === 'string' && Object.keys(FILAMENT_PRESETS).includes(f)))) &&
    typeof p.preset === 'string' &&
    PRESETS.some((preset) => preset.name === p.preset) &&
    !!p.overrides &&
    typeof p.overrides === 'object'
  )
}

function loadUserPresets(): UserPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // A preset referencing a printer/filament/preset removed in a later app
    // version is dropped rather than crashing the whole list.
    const valid = parsed.filter(isUserPreset)
    const droppedCount = parsed.length - valid.length
    if (droppedCount > 0) {
      logWarn(`Dropped ${droppedCount} saved preset(s) referencing a printer/filament/preset that no longer exists`)
    }
    return valid
  } catch (err) {
    logWarn('Failed to load saved presets — starting with an empty list', err)
    return []
  }
}

// Reverse-lookup a preset key (e.g. "Bambu Lab X1C") from a raw engine field
// value (e.g. printer_model: "Bambu Lab X1 Carbon") — the two differ because
// preset keys are UI labels while the field values are the literal OrcaSlicer
// option strings. Used to keep the Printer/Material dropdowns in sync with a
// value that arrived via 3MF import rather than the dropdown itself.
function findPresetKeyByField(
  presets: Record<string, Partial<OrcaConfig>>,
  field: keyof OrcaConfig,
  value: unknown,
): string | undefined {
  return Object.keys(presets).find((key) => presets[key][field] === value)
}

// Returns an array with the same File objects, in the same order, as `next`
// — but reuses the *previous* array reference whenever the actual set of
// files hasn't changed. `queue` (from useSliceQueue) gets a brand-new array
// reference on every SLICE_PROGRESS/CONFIG_CHANGED dispatch even though the
// underlying File objects didn't change, so deriving previewFiles with a
// plain `useMemo(..., [queue])` gave ModelViewer a "new" `files` prop on
// every progress tick — tearing down and rebuilding the whole WebGL scene
// (re-parsing every STL, resetting camera framing, visible flicker) while
// slicing. Comparing by File identity here instead of by wrapper-array
// identity keeps the prop stable across those unrelated re-renders.
//
// The ref write below happens during render, which is safe here specifically
// because this is a pure cache: the write is idempotent, derives only from
// `next`, and the comparison re-runs on every render — so a render that
// concurrent React throws away can't leave a wrong value behind, only a
// harmlessly-primed one. (A `useMemo` keyed on a derived identity string
// would avoid the write, but then the memo's real dependency — `queue` — is
// absent from its dependency list, which trades a documented ref cache for a
// lint suppression.)
function useStableFileList(next: File[]): File[] {
  const ref = useRef<File[]>([])
  const prev = ref.current
  const same = prev.length === next.length && prev.every((f, i) => f === next[i])
  if (!same) ref.current = next
  return ref.current
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
  const [activeTab, setActiveTab] = useState<Tab>('upload')

  const [saved] = useState(loadSavedSettings)
  const [selectedPreset, setSelectedPreset] = useState(saved?.preset ?? 'standard')
  const [selectedPrinter, setSelectedPrinter] = useState(saved?.printer ?? Object.keys(PRINTER_PRESETS)[0])
  // One entry per filament slot; slot 0 is what the settings panel's scalar
  // fields show. Falls back to the legacy single-slot setting.
  const [selectedFilaments, setSelectedFilaments] = useState<string[]>(() =>
    saved?.filaments?.length ? saved.filaments : [saved?.filament ?? 'PLA'],
  )
  const selectedFilament = selectedFilaments[0]
  const setSelectedFilament = useCallback((name: string) => {
    setSelectedFilaments((prev) => (prev.length <= 1 ? [name] : prev.map((s, i) => (i === 0 ? name : s))))
  }, [])
  const [manualOverrides, setManualOverrides] = useState<Partial<OrcaConfig>>(saved?.manualOverrides ?? {})
  const [importedProfile, setImportedProfile] = useState<ImportedProfile | null>(saved?.importedProfile ?? null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const [userPresets, setUserPresets] = useState<UserPreset[]>(loadUserPresets)

  const baseConfig = useMemo(
    () => buildConfig(selectedPrinter, selectedFilaments, selectedPreset),
    [selectedPrinter, selectedFilaments, selectedPreset],
  )
  // preset < imported file < manual edits — see config-layers.ts for what
  // each layer is and why the manual one must outlive changes to the others.
  const config: OrcaConfig = useMemo(
    () =>
      withFilamentSlots(
        resolveConfig({ preset: baseConfig, imported: importedProfile?.settings, manual: manualOverrides }),
        selectedFilaments,
      ),
    [baseConfig, importedProfile, manualOverrides, selectedFilaments],
  )

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          printer: selectedPrinter,
          filament: selectedFilament,
          filaments: selectedFilaments,
          preset: selectedPreset,
          manualOverrides,
          ...(importedProfile ? { importedProfile } : {}),
        } satisfies SavedSettings),
      )
    } catch (err) {
      logWarn('Failed to persist settings — storage full or unavailable', err)
    }
  }, [selectedPrinter, selectedFilament, selectedFilaments, selectedPreset, manualOverrides, importedProfile])

  useEffect(() => {
    try {
      localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(userPresets))
    } catch (err) {
      logWarn('Failed to persist saved presets — storage full or unavailable', err)
    }
  }, [userPresets])

  // Captures the full current selection (printer/filament/quality + manual
  // overrides) under a name. Deliberately excludes any active imported
  // profile — a saved preset is meant to be a self-contained, portable
  // selection built from the app's own presets, not a pointer to a specific
  // imported file the user may not still have.
  const saveUserPreset = useCallback(
    (name: string) => {
      const preset: UserPreset = {
        id: crypto.randomUUID(),
        name,
        printer: selectedPrinter,
        filament: selectedFilament,
        filaments: selectedFilaments,
        preset: selectedPreset,
        overrides: manualOverrides,
        createdAt: new Date().toISOString(),
      }
      // Two presets with the same name are indistinguishable in the list, so
      // reusing a name means "update that one" — with a confirm, since it
      // discards whatever was stored under it.
      const clash = userPresets.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())
      if (clash) {
        if (!window.confirm(`A preset named "${clash.name}" already exists. Replace it?`)) return
        setUserPresets((prev) => prev.map((p) => (p.id === clash.id ? { ...preset, id: clash.id } : p)))
        return
      }
      setUserPresets((prev) => [...prev, preset])
    },
    [selectedPrinter, selectedFilament, selectedFilaments, selectedPreset, manualOverrides, userPresets],
  )

  // Applies a saved preset's full selection in one go. The four setState
  // calls below are batched into a single re-render (called from a plain
  // event handler), so `config` recomputes exactly once and useSliceQueue's
  // configEpoch bumps once — not once per field — matching how
  // handlePresetChange/handlePrinterChange/handleProfileImported already
  // apply their own multi-field updates atomically.
  const loadUserPreset = useCallback(
    (id: string) => {
      const p = userPresets.find((preset) => preset.id === id)
      if (!p) return
      // A saved preset is a complete selection, so it has to replace the
      // imported-profile layer rather than sit under it — otherwise the
      // import's fields would keep winning and the preset would only
      // partially apply. That drops settings the user can't get back from
      // here (the source file isn't retained), so it's confirmed rather than
      // done silently, and only when there's actually something to lose.
      if (importedProfile) {
        const ok = window.confirm(
          `Loading "${p.name}" will discard the settings imported from ${importedProfile.name}.\n\n` +
            `You'll need the original file to get them back. Continue?`,
        )
        if (!ok) return
      }
      setSelectedPrinter(p.printer)
      // The whole slot list, not just slot 0 — a preset is a complete
      // selection, so loading one has to replace however many slots are
      // currently defined rather than leave the extra ones standing. `filament`
      // is the legacy single-slot field, kept for presets saved by an older
      // build.
      setSelectedFilaments(p.filaments?.length ? p.filaments : [p.filament])
      setSelectedPreset(p.preset)
      setManualOverrides(p.overrides)
      setImportedProfile(null)
    },
    [userPresets, importedProfile],
  )

  // Confirmed because it's immediate and unrecoverable — the preset only
  // exists in localStorage and the list offers no undo. The prompt sits
  // outside the state updater deliberately: updaters must be pure, and
  // StrictMode double-invokes them, so prompting from inside would show the
  // dialog twice in development.
  const deleteUserPreset = useCallback(
    (id: string) => {
      const target = userPresets.find((p) => p.id === id)
      if (!target) return
      if (!window.confirm(`Delete the preset "${target.name}"? This can't be undone.`)) return
      setUserPresets((prev) => prev.filter((p) => p.id !== id))
    },
    [userPresets],
  )

  // Settings embedded in an imported file (3MF) form their own layer so later
  // dropdown changes cannot silently erase them.
  const handleSettingsImported = useCallback(
    (patch: Partial<OrcaConfig>, filename: string) => {
      setImportedProfile({ name: filename, type: 'print', settings: patch })
      // Sync the dropdowns too — without this, config.printer_model/filament_type
      // get overridden correctly (visible on the Slice tab) but the Settings tab
      // dropdowns keep showing whatever was selected before import, and touching
      // either one afterwards wipes every imported override via
      // onPrinterChange/onFilamentChange's setConfigOverrides({}) reset.
      if (patch.printer_model !== undefined) {
        const matched = findPresetKeyByField(PRINTER_PRESETS, 'printer_model', patch.printer_model)
        if (matched) setSelectedPrinter(matched)
      }
      if (patch.filament_type !== undefined) {
        const matched = findPresetKeyByField(FILAMENT_PRESETS, 'filament_type', patch.filament_type)
        if (matched) setSelectedFilament(matched)
      }
      setImportNotice(`Imported print settings from ${filename}`)
    },
    [setSelectedFilament],
  )

  useEffect(() => {
    if (!importNotice) return
    const id = setTimeout(() => setImportNotice(null), 6000)
    return () => clearTimeout(id)
  }, [importNotice])

  const {
    items: queue,
    plate,
    wasmStatus,
    engineLabel,
    addFiles,
    removeItem,
    sliceAll,
    assignExtruder,
    slicePlate,
    cancel,
    export3mf,
  } = useSliceQueue(config, handleSettingsImported)

  const bedX = config.bed_size_x ?? DISPLAY_DEFAULTS.bed_size_x
  const bedY = config.bed_size_y ?? DISPLAY_DEFAULTS.bed_size_y
  const bedShape = config.bed_shape ?? DISPLAY_DEFAULTS.bed_shape

  // Labels for the queue's per-object filament picker, one per real slot.
  // Shared with useSliceQueue, which uses the same count to drop assignments
  // that no longer name a slot — the two must not disagree.
  const slotLabels = useMemo(() => filamentSlotLabels(config), [config])

  // None of these three touch manualOverrides: they swap a layer *below* the
  // user's own edits, which outrank them and stay put (config-layers.ts).
  // Overrides go away only on an explicit revert / "Reset all", or when a
  // saved user preset replaces the whole selection.
  //
  // Each bails out only when the click would change nothing at all. Testing
  // the name alone isn't enough: re-picking the already-selected entry is
  // also how you shed an import of that kind, and the quality chips are
  // plain buttons that fire even when they're already active (the <select>s
  // can't fire on an unchanged value, but the guard is the same shape for
  // all three rather than relying on that).
  const handlePresetChange = (name: string) => {
    const presetImport = importedProfile?.type === 'process' || importedProfile?.type === 'print'
    if (name === selectedPreset && !presetImport) return
    setSelectedPreset(name)
    setImportedProfile((profile) => (profile?.type === 'process' || profile?.type === 'print' ? null : profile))
  }

  const handleProfileImported = (profile: ImportedProfile) => {
    setImportedProfile(profile)
    const printer =
      profile.settings.printer_model === undefined
        ? undefined
        : findPresetKeyByField(PRINTER_PRESETS, 'printer_model', profile.settings.printer_model)
    if (printer) setSelectedPrinter(printer)
    const filament =
      profile.settings.filament_type === undefined
        ? undefined
        : findPresetKeyByField(FILAMENT_PRESETS, 'filament_type', profile.settings.filament_type)
    if (filament) setSelectedFilament(filament)
  }

  const handlePrinterChange = (name: string) => {
    if (name === `Imported: ${importedProfile?.name}`) return
    if (name === selectedPrinter && importedProfile?.type !== 'machine') return
    setSelectedPrinter(name)
    setImportedProfile((profile) => (profile?.type === 'machine' ? null : profile))
  }

  const handleFilamentsChange = (names: string[]) => {
    const next = names.length > 0 ? names : ['PLA']
    // Same "does this click change anything?" guard the printer/preset
    // handlers use — re-picking the current material is also how you shed a
    // filament import, so an unchanged list still has to drop that layer.
    const unchanged = next.length === selectedFilaments.length && next.every((n, i) => n === selectedFilaments[i])
    if (unchanged && importedProfile?.type !== 'filament') return
    setSelectedFilaments(next)
    // An imported filament profile describes slot 0 — that is the only slot
    // whose scalars it feeds — so only a change there sheds it. Adding or
    // removing a *slot*, or repicking a material further down the list, leaves
    // the import standing rather than silently discarding a file the user
    // still has selected.
    if (next[0] !== selectedFilament || unchanged) {
      setImportedProfile((profile) => (profile?.type === 'filament' ? null : profile))
    }
  }

  const handleRevertField = useCallback((key: ConfigField) => {
    setManualOverrides((prev) => revertField(prev, key))
  }, [])

  const handleRevertAll = useCallback(() => setManualOverrides({}), [])

  // ── Derived state ─────────────────────────────────────────────────────────

  // Every ready/done model, not just the first — the preview shows the whole
  // set laid out on a grid (see ModelViewer's doc comment) instead of only
  // ever showing one object when multiple files are queued. Passed through
  // useStableFileList so a queue update that doesn't actually add/remove/
  // replace a model (e.g. a SLICE_PROGRESS tick) doesn't hand ModelViewer a
  // "new" files array and force it to rebuild the WebGL scene.
  const rawPreviewFiles = useMemo(() => queue.map((i) => i.stlFile).filter((f): f is File => f != null), [queue])
  const previewFiles = useStableFileList(rawPreviewFiles)
  // Clears a previous ViewerErrorBoundary crash when the file set actually
  // changes (passed as resetKey, not key — see the boundary's own doc
  // comment for why remounting the viewer here would be the wrong tool).
  // Includes size/lastModified so two same-named files still read as a
  // change.
  const previewFilesKey = previewFiles.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|')
  const hasAnyReady = queue.some((i) => i.stlFile != null)
  const isConverting = queue.some((i) => i.status === 'converting')

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-orca-50 flex flex-col">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <OrcaLogo className="w-7 h-7 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-800 tracking-tight">OrcaWeb</span>
                <span className="hidden sm:block text-xs text-slate-400 font-medium bg-slate-100 px-2 py-0.5 rounded-full">
                  Browser Slicer
                </span>
              </div>
              <div className="text-xs text-slate-400 font-mono">
                v{__APP_VERSION__} · {__APP_RELEASE_DATE__} · engine {engineLabel}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
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
              type="button"
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              disabled={tab.id !== 'upload' && !hasAnyReady}
              data-testid={`tab-${tab.id}`}
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

        {importNotice && (
          <div className="mb-4 flex items-center gap-2 text-sm text-orca-700 bg-orca-50 border border-orca-200 rounded-xl px-4 py-2.5">
            <span className="font-medium">✓</span> {importNotice}
          </div>
        )}

        {/* ── Upload tab ── */}
        {activeTab === 'upload' && (
          <div className="space-y-4">
            <FileUpload loadedCount={queue.length} onFiles={addFiles} />

            {queue.length > 0 && (
              <div className="space-y-2">
                {queue.map((item) => (
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
                      {item.status === 'converting' && <p className="text-xs text-amber-600">Converting…</p>}
                      {item.status === 'error' && <p className="text-xs text-red-500 truncate">{item.error}</p>}
                      {(item.status === 'ready' || item.status === 'done') && item.originalSize > 0 && (
                        <p className="text-xs text-slate-400">{formatBytes(item.originalSize)}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeItem(item.id)
                      }}
                      title="Remove"
                      className="text-slate-300 hover:text-red-400 transition-colors p-1"
                    >
                      <XIcon className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {previewFiles.length > 0 && (
              <div className="rounded-2xl overflow-hidden border border-slate-200 bg-white" style={{ height: 300 }}>
                <ViewerErrorBoundary resetKey={previewFilesKey} message="3D preview unavailable">
                  <ModelViewer files={previewFiles} bedX={bedX} bedY={bedY} bedShape={bedShape} />
                </ViewerErrorBoundary>
              </div>
            )}

            {hasAnyReady && (
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className="w-full py-3 rounded-xl bg-orca-500 hover:bg-orca-600 text-white font-semibold transition-colors"
              >
                Continue to settings →
              </button>
            )}

            {isConverting && !hasAnyReady && <p className="text-sm text-center text-slate-400">Converting files…</p>}
          </div>
        )}

        {/* ── Settings tab ── */}
        {activeTab === 'settings' && hasAnyReady && (
          <div className="grid sm:grid-cols-[1fr_1.4fr] gap-6">
            {previewFiles.length > 0 && (
              <div
                className="rounded-2xl overflow-hidden border border-slate-200 bg-white order-last sm:order-first"
                style={{ height: 320 }}
              >
                <ViewerErrorBoundary resetKey={previewFilesKey} message="3D preview unavailable">
                  <ModelViewer files={previewFiles} bedX={bedX} bedY={bedY} bedShape={bedShape} />
                </ViewerErrorBoundary>
              </div>
            )}
            <div className="bg-white rounded-2xl border border-slate-200 p-5 overflow-y-auto">
              <SettingsPanel
                config={config}
                onChange={(patch) => setManualOverrides((prev) => mergeConfigLayers(prev, patch))}
                overrides={manualOverrides}
                onRevertField={handleRevertField}
                onRevertAll={handleRevertAll}
                onProfileImport={handleProfileImported}
                activeImport={
                  importedProfile && {
                    name: importedProfile.name,
                    type: importedProfile.type,
                    settingCount: countProfileSettings(importedProfile.settings),
                  }
                }
                onRemoveImport={() => setImportedProfile(null)}
                selectedPreset={selectedPreset}
                onPresetChange={handlePresetChange}
                selectedPrinter={selectedPrinter}
                importedPrinterLabel={
                  importedProfile?.type === 'machine' ? `Imported: ${importedProfile.name}` : undefined
                }
                onPrinterChange={handlePrinterChange}
                selectedFilaments={selectedFilaments}
                onFilamentsChange={handleFilamentsChange}
                userPresets={userPresets}
                onSaveUserPreset={saveUserPreset}
                onLoadUserPreset={loadUserPreset}
                onDeleteUserPreset={deleteUserPreset}
              />
              <button
                type="button"
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
              queue={queue}
              plate={plate}
              wasmStatus={wasmStatus}
              onSliceAll={sliceAll}
              onSlicePlate={slicePlate}
              onCancel={cancel}
            />

            {(plate.gcode || plate.slicing || plate.error) && (
              <PlateResultCard plate={plate} bedX={bedX} bedY={bedY} bedShape={bedShape} />
            )}

            <div className="space-y-3">
              {queue.map((item) => (
                <QueueItemCard
                  key={item.id}
                  item={item}
                  bedX={bedX}
                  bedY={bedY}
                  bedShape={bedShape}
                  onExport3mf={export3mf}
                  filamentSlotLabels={slotLabels}
                  onAssignExtruder={assignExtruder}
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

// ── Engine status badge ───────────────────────────────────────────────────────

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
