import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileUpload } from './components/FileUpload'
import { ErrorDotIcon, GithubIcon, ModelIconSm, OrcaLogo, SpinnerIcon, XIcon } from './components/icons'
import { ModelViewer } from './components/ModelViewer'
import { SettingsPanel } from './components/SettingsPanel'
import { ConfigSummary, PlateResultCard, QueueItemCard, SliceHeader } from './components/SliceCards'
import { useSliceQueue } from './hooks/useSliceQueue'
import { formatBytes } from './lib/format'
import { logWarn } from './lib/log'
import { buildConfig, DISPLAY_DEFAULTS, FILAMENT_PRESETS, PRESETS, PRINTER_PRESETS } from './lib/profiles'
import type { WasmStatus } from './lib/worker-singleton'
import type { OrcaConfig } from './types'

// ── Persisted settings ────────────────────────────────────────────────────────

const SETTINGS_KEY = 'orcaweb.settings.v1'

interface SavedSettings {
  printer: string
  filament: string
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

function mergeConfigLayers(...layers: Partial<OrcaConfig>[]): OrcaConfig {
  const passthrough = Object.assign({}, ...layers.map((layer) => layer._passthrough ?? {}))
  return {
    ...Object.assign({}, ...layers),
    ...(Object.keys(passthrough).length > 0 ? { _passthrough: passthrough } : {}),
  } as OrcaConfig
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
  const [selectedFilament, setSelectedFilament] = useState(saved?.filament ?? 'PLA')
  const [manualOverrides, setManualOverrides] = useState<Partial<OrcaConfig>>(saved?.manualOverrides ?? {})
  const [importedProfile, setImportedProfile] = useState<ImportedProfile | null>(saved?.importedProfile ?? null)
  const [importNotice, setImportNotice] = useState<string | null>(null)

  const baseConfig = useMemo(
    () => buildConfig(selectedPrinter, selectedFilament, selectedPreset),
    [selectedPrinter, selectedFilament, selectedPreset],
  )
  const config: OrcaConfig = useMemo(
    () => mergeConfigLayers(baseConfig, importedProfile?.settings ?? {}, manualOverrides),
    [baseConfig, importedProfile, manualOverrides],
  )

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          printer: selectedPrinter,
          filament: selectedFilament,
          preset: selectedPreset,
          manualOverrides,
          ...(importedProfile ? { importedProfile } : {}),
        } satisfies SavedSettings),
      )
    } catch (err) {
      logWarn('Failed to persist settings — storage full or unavailable', err)
    }
  }, [selectedPrinter, selectedFilament, selectedPreset, manualOverrides, importedProfile])

  // Settings embedded in an imported file (3MF) form their own layer so later
  // dropdown changes cannot silently erase them.
  const handleSettingsImported = useCallback((patch: Partial<OrcaConfig>, filename: string) => {
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
  }, [])

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
    slicePlate,
    cancel,
    export3mf,
  } = useSliceQueue(config, handleSettingsImported)

  const bedX = config.bed_size_x ?? DISPLAY_DEFAULTS.bed_size_x
  const bedY = config.bed_size_y ?? DISPLAY_DEFAULTS.bed_size_y
  const bedShape = config.bed_shape ?? DISPLAY_DEFAULTS.bed_shape

  const handlePresetChange = (name: string) => {
    setSelectedPreset(name)
    setManualOverrides({})
    setImportedProfile((profile) => (profile?.type === 'process' ? null : profile))
  }

  const handleProfileImported = (profile: ImportedProfile) => {
    setImportedProfile(profile)
    setManualOverrides({})
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
    setSelectedPrinter(name)
    setManualOverrides({})
    setImportedProfile((profile) => (profile?.type === 'machine' ? null : profile))
  }

  const handleFilamentChange = (name: string) => {
    setSelectedFilament(name)
    setManualOverrides({})
    setImportedProfile((profile) => (profile?.type === 'filament' ? null : profile))
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const previewFile = useMemo(() => queue.find((i) => i.stlFile != null)?.stlFile ?? null, [queue])
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

            {isConverting && !hasAnyReady && <p className="text-sm text-center text-slate-400">Converting files…</p>}
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
                onChange={(patch) => setManualOverrides((prev) => mergeConfigLayers(prev, patch))}
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
                selectedFilament={selectedFilament}
                onFilamentChange={handleFilamentChange}
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
