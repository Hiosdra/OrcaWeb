export interface OrcaConfig {
  // Printer
  printer_model?: string
  nozzle_diameter?: number
  /** Print bed width in mm (used for model centering in the WASM bridge) */
  bed_size_x?: number
  /** Print bed depth in mm (used for model centering in the WASM bridge) */
  bed_size_y?: number

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
  enable_ironing?: boolean

  // Machine
  printable_height?: number

  // Arbitrary OrcaSlicer fields not modeled above — forwarded verbatim to WASM
  _passthrough?: Record<string, string>
}

export type InfillPattern =
  | 'grid'
  | 'gyroid'
  | 'honeycomb'
  | 'triangles'
  | 'cubic'
  | 'lightning'
  | 'rectilinear'

export type SupportType = 'normal(auto)' | 'normal(manual)' | 'tree(auto)' | 'tree(manual)'

export type SeamPosition = 'aligned' | 'nearest' | 'back' | 'random'

export type FuzzySkin = 'none' | 'outer' | 'all'

export interface SlicePreset {
  name: string
  label: string
  description: string
  config: Partial<OrcaConfig>
}

// --- Worker message protocol ---

export type WorkerInMessage =
  | { type: 'LOAD_WASM'; url: string }
  | { type: 'SLICE'; stl: ArrayBuffer; config: OrcaConfig }
  | { type: 'OBJ_TO_STL'; obj: ArrayBuffer }

export type WorkerOutMessage =
  | { type: 'WORKER_READY' }
  | { type: 'WASM_LOADED' }
  | { type: 'WASM_ERROR'; message: string }
  | { type: 'SLICE_COMPLETE'; gcode: string }
  | { type: 'SLICE_ERROR'; code: number; message: string }
  | { type: 'OBJ_STL_COMPLETE'; stl: ArrayBuffer }
  | { type: 'OBJ_STL_ERROR'; message: string }

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
  _orc_init(payloadPtr: number, payloadLen: number): number
  _orc_slice(
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
  _orc_free(ptr: number): void
  _orc_decode_exception(ptr: number): string
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
