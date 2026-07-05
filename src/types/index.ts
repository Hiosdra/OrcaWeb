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
  initial_layer_height?: number
  top_shell_layers?: number
  bottom_shell_layers?: number
  wall_loops?: number

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

export type SupportType = 'normal(auto)' | 'normal(manual)' | 'tree(auto)' | 'tree(manual)'

export type SeamPosition = 'aligned' | 'nearest' | 'back' | 'random'

export type FuzzySkin = 'none' | 'external' | 'all'

export interface SlicePreset {
  name: string
  label: string
  description: string
  config: Partial<OrcaConfig>
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
  | { type: 'OBJ_TO_STL'; obj: ArrayBuffer; filename: string }
  | { type: 'CAD_TO_STL'; cad: ArrayBuffer; filename: string }

export type WorkerOutMessage =
  | { type: 'WORKER_READY' }
  | { type: 'WASM_LOADED' }
  | { type: 'WASM_ERROR'; message: string }
  | { type: 'SLICE_COMPLETE'; gcode: string }
  | { type: 'SLICE_ERROR'; code: number; message: string }
  | { type: 'SLICE_MULTI_COMPLETE'; gcode: string }
  | { type: 'SLICE_MULTI_ERROR'; code: number; message: string }
  | { type: 'OBJ_STL_COMPLETE'; stl: ArrayBuffer; filename: string }
  | { type: 'OBJ_STL_ERROR'; message: string; filename: string }
  | { type: 'CAD_STL_COMPLETE'; stl: ArrayBuffer; filename: string }
  | { type: 'CAD_STL_ERROR'; message: string; filename: string }

// --- G-code statistics ---

export interface GcodeStats {
  /** Total bytes in the G-code file */
  bytes: number
  /** Total number of lines */
  lines: number
  /** Total layer count (from slicer comment) */
  layers?: number
  /** Estimated print time string, e.g. "1h 2m 5s" */
  printTime?: string
  /** Total filament length in mm */
  filamentMm?: number
  /** Total filament volume in cm³ */
  filamentCm3?: number
  /** Total filament weight in grams */
  filamentG?: number
}

// --- App state ---

export type AppStep = 'upload' | 'settings' | 'slice'

export type SliceStatus =
  | { phase: 'idle' }
  | { phase: 'loading-wasm' }
  | { phase: 'slicing' }
  | { phase: 'done'; gcode: string; filename: string }
  | { phase: 'error'; message: string }

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
  _orc_slice(
    session: number,
    inputPtr: number,
    inputLen: number,
    outputPtrPtr: number,
    outputLenPtr: number,
  ): number
  _orc_obj_to_stl(
    objPtr: number,
    objLen: number,
    outputPtrPtr: number,
    outputLenPtr: number,
  ): number
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
  _orc_cad_to_stl(
    cadPtr: number,
    cadLen: number,
    outputPtrPtr: number,
    outputLenPtr: number,
  ): number
  _orc_free(ptr: number): void
  // Pass the session used for a failing _orc_init/_orc_slice/_orc_slice_multi
  // call; pass 0 after a failing _orc_obj_to_stl/_orc_cad_to_stl call (those
  // take no session).
  _orc_decode_exception(session: number): number
  setValue(ptr: number, value: number, type: string): void
  getValue(ptr: number, type: string): number
  HEAPU8: Uint8Array
  UTF8ToString(ptr: number, length?: number): string
}

export interface OrcaModuleOptions {
  wasmBinary?: ArrayBuffer
  locateFile?: (path: string) => string
  printErr?: (msg: string) => void
  onAbort?: (msg: string) => void
}

export type OrcaModuleFactory = (options?: OrcaModuleOptions) => Promise<OrcaModule>
