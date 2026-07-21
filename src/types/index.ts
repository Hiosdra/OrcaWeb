export interface OrcaConfig {
  // Printer
  printer_model?: string
  nozzle_diameter?: number
  /** Print bed width in mm (used for model centering in the WASM bridge) */
  bed_size_x?: number
  /** Print bed depth in mm (used for model centering in the WASM bridge) */
  bed_size_y?: number
  /** Bed shape — 'circle' for delta / round printers, 'rectangle' (default) for cartesian */
  bed_shape?: 'rectangle' | 'circle'

  // Filament
  filament_type?: string
  nozzle_temperature?: number
  bed_temperature?: number
  fan_min_speed?: number

  // Process — quality
  layer_height?: number
  /** Real OrcaSlicer FFF field is `initial_layer_print_height` — the
   *  similarly-named `initial_layer_height` is an SLA-only option
   *  (PrintConfigDef::init_sla_params) with no effect on an FFF slice. */
  initial_layer_print_height?: number
  top_shell_layers?: number
  bottom_shell_layers?: number
  wall_loops?: number
  wall_generator?: WallGenerator

  // Process — infill
  sparse_infill_density?: number
  sparse_infill_pattern?: InfillPattern

  // Process — speed
  default_speed?: number
  outer_wall_speed?: number
  initial_layer_speed?: number
  travel_speed?: number

  // Process — support
  enable_support?: boolean
  support_type?: SupportType

  // Process — adhesion
  brim_width?: number
  brim_type?: BrimType
  skirt_loops?: number
  skirt_distance?: number
  raft_layers?: number

  // Process — other
  seam_position?: SeamPosition
  fuzzy_skin?: FuzzySkin
  fuzzy_skin_thickness?: number
  fuzzy_skin_point_dist?: number
  enable_ironing?: boolean

  // Machine
  printable_height?: number

  // Arbitrary OrcaSlicer fields not modeled above — forwarded verbatim to WASM
  _passthrough?: Record<string, string>
}

// Curated subset of PrintConfig.cpp's sparse_infill_pattern enum (26 values
// total) — the ones surfaced in the UI dropdown, plus crosshatch (Bambu's
// bundled quality-tier profiles default to it).
export type InfillPattern =
  | 'grid'
  | 'gyroid'
  | 'honeycomb'
  | 'triangles'
  | 'cubic'
  | 'lightning'
  | 'rectilinear'
  | 'crosshatch'

// Arachne (variable-width walls) is OrcaSlicer's real default and gives
// better wall quality, but its beading/transition algorithm can blow up in
// runtime on models with lots of small, continuously-varying-width features
// (e.g. calibration cubes with engraved text/tolerance slots) — sometimes
// taking many minutes where Classic (constant-width, offset-based) finishes
// in seconds. Exposed here so a slow/stuck slice has a user-facing escape
// hatch without needing to touch the engine defaults.
export type WallGenerator = 'arachne' | 'classic'

export type SupportType = 'normal(auto)' | 'normal(manual)' | 'tree(auto)' | 'tree(manual)'

export type SeamPosition = 'aligned' | 'nearest' | 'back' | 'random'

// Subset of PrintConfig.cpp's BrimType enum (s_keys_map_BrimType accepts all
// 7 keys — set_deserialize_strict doesn't reject any of them). 'auto_brim' is
// included because it's engine-computed (PrintConfig.cpp: "the brim width is
// analyzed and calculated automatically") and is also the engine's actual
// default (btAutoBrim) — worth representing even headless. 'brim_ears' and
// 'painted' are excluded: both require manual per-object markup done in the
// desktop UI (ear placement / brim painting) that this headless bridge has
// no equivalent input for, so setting either here would silently produce no
// brim at all rather than the ears/painted regions the user intended.
export type BrimType = 'auto_brim' | 'no_brim' | 'outer_only' | 'inner_only' | 'outer_and_inner'

export type FuzzySkin = 'none' | 'external' | 'all'

export interface SlicePreset {
  name: string
  label: string
  description: string
  config: Partial<OrcaConfig>
}

// A user-named, savable snapshot of a full settings selection (printer +
// filament + quality preset + manual overrides) — see App.tsx's
// USER_PRESETS_KEY persistence and SettingsPanel's "My presets" UI.
export interface UserPreset {
  id: string
  name: string
  printer: string
  filament: string
  preset: string
  overrides: Partial<OrcaConfig>
  createdAt: string
}

// --- Slice queue ---

export type QueueItemStatus = 'converting' | 'ready' | 'slicing' | 'done' | 'error'

/** OBJ mesh, CAD B-rep (STEP), or an OrcaSlicer 3MF project. */
export type ConversionKind = 'obj' | 'cad' | '3mf'

export interface QueueItem {
  id: string
  name: string
  originalSize: number
  /** Original uploaded file — kept so a conversion can be re-sent if the
   *  worker holding the in-flight request is terminated (user cancel). */
  sourceFile: File
  stlFile: File | null
  status: QueueItemStatus
  gcode?: string
  gcodeFilename?: string
  /** Set when the config changed after this item was sliced — its G-code no
   *  longer reflects the current settings and Slice re-runs it. */
  stale?: boolean
  /** 1-based filament/extruder slot this object is assigned to on a
   *  multi-material plate (undefined/0 = inherit the config default). Only
   *  meaningful when the config has more than one filament slot and the item
   *  is sliced via slicePlate() → orc_slice_multi's per-object `extruder`
   *  override; single slicing ignores it. See src/lib/profiles.ts's
   *  isMultiExtruderProfile note — this is the single-nozzle multi-material
   *  (AMS-style) path, not real multi-nozzle. */
  extruderId?: number
  error?: string
  /** Latest progress emitted by a progress-capable WASM engine while slicing. */
  progress?: SliceProgress
  /** Which engine request turns this item's sourceFile into an STL, decided
   *  once from the filename when the item is created. Stored rather than
   *  re-sniffed at each use so adding a new input format means touching one
   *  classifier, not every place that needs to know — repostConversions()
   *  silently not handling `.3mf` after a worker restart was exactly that
   *  bug. `undefined` means the file is already an STL. */
  conversion?: ConversionKind
}

export interface SliceProgress {
  percent: number
  stage: string
}

// --- Worker message protocol ---

export type WorkerInMessage =
  // version is appended as a cache-busting query param to the slicer.js/
  // slicer.wasm fetch URLs — see slicer.worker.ts for why. engineLabel is the
  // human-readable resolved WASM release tag (__ORCA_ENGINE_VERSION__), used
  // only for console diagnostics, never for cache-busting or URLs.
  | { type: 'LOAD_WASM'; url: string; version: string; engineLabel: string }
  | { type: 'SLICE'; stl: ArrayBuffer; config: OrcaConfig }
  | {
      type: 'SLICE_MULTI'
      stls: ArrayBuffer[]
      config: OrcaConfig
      // Optional per-object "extruder" override, parallel to stls (0/omitted
      // = inherit default). See orc_slice_multi in orca-wasm/bridge/slicer.cpp.
      extruderIds?: number[]
    }
  // requestId is opaque to the worker — echoed back verbatim on the matching
  // *_COMPLETE/*_ERROR so the main thread can correlate responses (it uses
  // the queue item id).
  | { type: 'OBJ_TO_STL'; obj: ArrayBuffer; requestId: string }
  | { type: 'CAD_TO_STL'; cad: ArrayBuffer; requestId: string }
  // Exports a single mesh + config as a .3mf (see orc_write_3mf in
  // orca-wasm/bridge/slicer.cpp) — no plate/gcode/thumbnail data.
  | { type: 'WRITE_3MF'; stl: ArrayBuffer; config: OrcaConfig; requestId: string }
  // Reads a .3mf's mesh + embedded config using OrcaSlicer's own reader
  // (see orc_read_3mf in orca-wasm/bridge/slicer.cpp).
  | { type: 'READ_3MF'; mf: ArrayBuffer; requestId: string }

export type WorkerOutMessage =
  // engineLabel is the runtime-resolved human-readable engine version (from
  // engine-version.json — see slicer.worker.ts); absent when the engine was
  // already loaded (re-signalled) or on the baked-fallback path.
  | { type: 'WASM_LOADED'; engineLabel?: string }
  | { type: 'WASM_ERROR'; message: string }
  | { type: 'SLICE_PROGRESS'; percent: number; stage: string }
  | { type: 'SLICE_COMPLETE'; gcode: string }
  | { type: 'SLICE_ERROR'; code: number; message: string }
  | { type: 'SLICE_MULTI_COMPLETE'; gcode: string }
  | { type: 'SLICE_MULTI_ERROR'; code: number; message: string }
  | { type: 'OBJ_STL_COMPLETE'; stl: ArrayBuffer; requestId: string }
  | { type: 'OBJ_STL_ERROR'; message: string; requestId: string }
  | { type: 'CAD_STL_COMPLETE'; stl: ArrayBuffer; requestId: string }
  | { type: 'CAD_STL_ERROR'; message: string; requestId: string }
  | { type: 'WRITE_3MF_COMPLETE'; data: ArrayBuffer; requestId: string }
  | { type: 'WRITE_3MF_ERROR'; message: string; requestId: string }
  | { type: 'READ_3MF_COMPLETE'; stl: ArrayBuffer; configJson: string; requestId: string }
  | { type: 'READ_3MF_ERROR'; message: string; requestId: string }

// --- G-code statistics ---

export interface GcodeStats {
  /** Total layer count (from slicer comment) */
  layers?: number
  /** Estimated print time string, e.g. "1h 2m 5s" */
  printTime?: string
  /** Total filament length in mm */
  filamentMm?: number
  /** Total filament weight in grams */
  filamentG?: number
}

export interface OrcaModule {
  _malloc(size: number): number
  _free(ptr: number): void
  // Session handle — one per worker for the worker's whole lifetime today
  // (see src/lib/wasm-loader.ts), but scoping engine state behind an opaque
  // handle instead of module-wide globals means a future caller (Node CLI,
  // worker pool) can safely hold more than one independent slicer session.
  _orc_session_create(): number
  _orc_session_destroy(session: number): void
  _orc_init(session: number, payloadPtr: number, payloadLen: number): number
  _orc_slice(session: number, inputPtr: number, inputLen: number, outputPtrPtr: number, outputLenPtr: number): number
  _orc_obj_to_stl(objPtr: number, objLen: number, outputPtrPtr: number, outputLenPtr: number): number
  _orc_slice_multi(
    session: number,
    dataPtr: number,
    dataLen: number,
    offsetsPtr: number,
    nFiles: number,
    // Nullable (pass 0) i32 array pointer, one 1-based "extruder" override per
    // file (0 = inherit default). See orca-wasm/bridge/slicer.cpp's
    // orc_slice_multi doc comment for exactly what this does and does not enable.
    extruderIdsPtr: number,
    outputPtrPtr: number,
    outputLenPtr: number,
  ): number
  _orc_cad_to_stl(cadPtr: number, cadLen: number, outputPtrPtr: number, outputLenPtr: number): number
  _orc_write_3mf(session: number, stlPtr: number, stlLen: number, outputPtrPtr: number, outputLenPtr: number): number
  _orc_read_3mf(
    mfPtr: number,
    mfLen: number,
    outStlPtrPtr: number,
    outStlLenPtr: number,
    outConfigPtrPtr: number,
    outConfigLenPtr: number,
  ): number
  _orc_free(ptr: number): void
  // Pass the session used for a failing _orc_init/_orc_slice/_orc_slice_multi
  // call; pass 0 after a failing _orc_obj_to_stl/_orc_cad_to_stl/_orc_read_3mf
  // call (those take no session).
  _orc_decode_exception(session: number): number
  setValue(ptr: number, value: number, type: string): void
  getValue(ptr: number, type: string): number
  HEAPU8: Uint8Array
  UTF8ToString(ptr: number, length?: number): string
}

export interface OrcaModuleOptions {
  /** Emscripten hook: caller supplies the compiled+instantiated wasm instance
   *  via successCallback (lets us use WebAssembly.compileStreaming). The
   *  module argument is required, not optional — Emscripten's internal
   *  receiveInstance(instance, module) stores it as `wasmModule`, which
   *  pthread worker spawning (MT builds) reads to share the compiled module
   *  with new pthread workers; omitting it leaves pthread workers crashing
   *  on an undefined module. */
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => Record<string, never>
  locateFile?: (path: string) => string
  printErr?: (msg: string) => void
  onAbort?: (msg: string) => void
  /** Emscripten pthread hook: script used to spawn pool workers. A Blob is
   *  minted into a same-origin blob: URL per worker; a string is used as-is
   *  (so it must be same-origin, else `new Worker()` throws cross-origin). */
  mainScriptUrlOrBlob?: string | Blob
}

export type OrcaModuleFactory = (options?: OrcaModuleOptions) => Promise<OrcaModule>
