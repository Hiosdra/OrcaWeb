# API Reference

## WASM C API

Exported by `slicer.wasm` via Emscripten. Called from `src/lib/wasm-loader.ts`.

### `_orc_init`

```c
int _orc_init(const char* config_json, int len);
```

Initialise the slicer with a JSON configuration string.

**Parameters**

- `config_json` — pointer to UTF-8 JSON string on the WASM heap
- `len` — byte length of the string

**Returns** `0` on success, non-zero on failure.

**Must be called before** `_orc_slice`.

---

### `_orc_slice`

```c
int _orc_slice(
  const uint8_t* stl_data, int stl_len,
  uint8_t**      out_ptr,
  int*           out_len
);
```

Slice an STL file and write G-code to a newly allocated buffer.

**Parameters**

- `stl_data` — pointer to binary or ASCII STL on the WASM heap
- `stl_len` — byte length of the STL
- `out_ptr` — pointer to a pointer; written with the address of the output G-code buffer
- `out_len` — pointer to an int; written with the length of the output buffer

**Returns**

| Code | Meaning |
|------|---------|
| `0` | Success |
| `-1` | STL failed to load (invalid / non-manifold geometry) |
| `-2` | No printable objects found after parsing |
| `-3` | G-code generation failed |
| `-4` | Unhandled C++ exception |

**After reading** the output buffer, free it with `_free(out_ptr)`.

---

## Memory management

The WASM module uses an Emscripten-managed heap. JavaScript must allocate and free manually.

```typescript
// Allocate on the WASM heap
const ptr = module._malloc(byteLength)

// Write bytes
module.HEAPU8.set(data, ptr)

// Write an i32 at ptr
module.setValue(ptr, value, 'i32')

// Read an i32 from ptr
const val = module.getValue(ptr, 'i32')

// Read a null-terminated C string
const str = module.UTF8ToString(ptr)

// Free
module._free(ptr)
```

---

## TypeScript interface

```typescript
interface OrcaModule {
  _malloc(size: number): number
  _free(ptr: number): void
  _orc_init(configPtr: number, len: number): number
  _orc_slice(
    stlPtr: number, stlLen: number,
    outPtrPtr: number, outLenPtr: number,
  ): number
  setValue(ptr: number, value: number, type: string): void
  getValue(ptr: number, type: string): number
  UTF8ToString(ptr: number): string
  HEAPU8: Uint8Array
}
```

---

## Worker message protocol

Communication between the main thread and the Web Worker.

### Main → Worker

```typescript
// Start WASM loading
{ type: 'LOAD_WASM'; url: string }

// Slice an STL file
{
  type: 'SLICE'
  stl: ArrayBuffer   // transferred (zero-copy)
  config: OrcaConfig
}
```

### Worker → Main

```typescript
// Worker script evaluated, ready to receive messages
{ type: 'WORKER_READY' }

// WASM module fully loaded
{ type: 'WASM_LOADED' }

// WASM failed to load
{ type: 'WASM_ERROR'; message: string }

// Slicing finished
{ type: 'SLICE_COMPLETE'; gcode: string }

// Slicing failed
{ type: 'SLICE_ERROR'; code: number; message: string }
```

---

## Config JSON schema

Sent to `_orc_init`. All fields are optional; unset fields use OrcaSlicer defaults from `slicer.data`.

```typescript
interface OrcaConfig {
  // Machine
  printer_model?: string           // e.g. "BambuLab X1C"
  nozzle_diameter?: number         // mm, e.g. 0.4
  bed_size_x?: number              // print bed width in mm (used for model centering)
  bed_size_y?: number              // print bed depth in mm

  // Filament
  filament_type?: string           // "PLA" | "PETG" | "ABS" | "TPU"
  nozzle_temperature?: number      // °C
  bed_temperature?: number         // °C
  fan_min_speed?: number           // 0–100%

  // Quality
  layer_height?: number            // mm
  initial_layer_height?: number    // mm
  top_shell_layers?: number
  bottom_shell_layers?: number
  wall_loops?: number

  // Infill
  sparse_infill_density?: number   // 0–100
  sparse_infill_pattern?: InfillPattern

  // Speed (mm/s)
  default_speed?: number
  outer_wall_speed?: number
  initial_layer_speed?: number
  travel_speed?: number

  // Supports
  enable_support?: boolean
  support_type?: SupportType
  brim_width?: number              // mm

  // Surface
  seam_position?: SeamPosition
  fuzzy_skin?: string
  enable_ironing?: boolean
}

type InfillPattern =
  | 'grid' | 'gyroid' | 'honeycomb' | 'triangles'
  | 'cubic' | 'lightning' | 'rectilinear'

type SupportType =
  | 'normal(auto)' | 'normal(manual)'
  | 'tree(auto)'   | 'tree(manual)'

type SeamPosition = 'aligned' | 'nearest' | 'back' | 'random'
```

---

## G-code statistics

`parseGcodeStats` (internal, called by `SlicePanel`) returns:

```typescript
interface GcodeStats {
  bytes: number            // UTF-8 byte size of the G-code file
  lines: number            // total line count
  layers?: number          // from "; total layers count = N"
  printTime?: string       // from "; estimated printing time = ..."
  filamentMm?: number      // from "; total filament used [mm] = N"
  filamentCm3?: number     // from "; total filament used [cm3] = N"
  filamentG?: number       // from "; total filament weight [g] = N"
}
```

Only the first 100 kB of the G-code string is scanned for header comments (stats are always at the top). File size uses `Blob.size` to avoid allocating a large `Uint8Array`.

---

## 3MF parser

```typescript
import { parse3mf } from './lib/parse3mf'

interface Parse3mfResult {
  stlBytes: Uint8Array        // binary STL converted from the 3MF mesh XML
  config: Partial<OrcaConfig> // merged settings from Metadata/ profiles
}

function parse3mf(data: ArrayBuffer): Parse3mfResult
```

Throws if the archive has no `3D/3dmodel.model` entry or contains no geometry.
