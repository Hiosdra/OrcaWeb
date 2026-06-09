export interface OrcaConfig {
  // Printer
  printer_model?: string
  nozzle_diameter?: number

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

export type WorkerOutMessage =
  | { type: 'WORKER_READY' }
  | { type: 'WASM_LOADED' }
  | { type: 'WASM_ERROR'; message: string }
  | { type: 'SLICE_COMPLETE'; gcode: string }
  | { type: 'SLICE_ERROR'; code: number; message: string }

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
