# API Reference

## WASM C API

Exported by `slicer.wasm` via Emscripten. Called from `src/lib/wasm-loader.ts`.

All functions use C linkage (`extern "C"`). The Emscripten JS glue (`slicer.js`) exposes them with a leading underscore, e.g. `_orc_init`.

---

### `orc_init`

```c
int orc_init(const char* config_json, int json_len);
```

Initialise the slicer with a JSON configuration object. Must be called before `orc_slice` or `orc_slice_multi`.

**Parameters**

- `config_json` — pointer to UTF-8 JSON string on the WASM heap
- `json_len` — byte length of the string

**Returns**

| Code | Meaning |
|---|---|
| `0` | Success |
| `-2` | JSON parse failure (not a valid JSON object) |
| `-9` | Unexpected C++ exception |

**Behaviour**

- Starts from OrcaSlicer's built-in defaults so all required fields are always present.
- Unknown JSON keys are silently ignored.
- The special keys `bed_size_x`, `bed_size_y`, and `bed_shape` are extracted for model centering and are **not** forwarded to the OrcaSlicer config engine.
- On success the configuration persists for all subsequent `orc_slice` / `orc_slice_multi` calls until `orc_init` is called again.

---

### `orc_slice`

```c
int orc_slice(
    const void* stl_data, int stl_len,
    char**      out_gcode, int* out_len
);
```

Slice an STL file and write G-code to a newly allocated buffer.

**Parameters**

- `stl_data` — pointer to binary or ASCII STL bytes on the WASM heap
- `stl_len` — byte length of the STL
- `out_gcode` — on success, written with the address of a malloc'd, null-terminated G-code string
- `out_len` — on success, written with the byte length of the G-code (excluding null terminator)

**Returns**

| Code | Meaning |
|---|---|
| `0` | Success |
| `-1` | Invalid arguments or `orc_init` was not called |
| `-3` | Could not write STL to MEMFS |
| `-4` | STL load failed (invalid or corrupt geometry) |
| `-5` | Model contains no objects |
| `-6` | Print validation failed |
| `-7` | Slicing error |
| `-8` | G-code export failed |
| `-9` | Unexpected C++ exception |

**Memory:** caller must free `*out_gcode` with `orc_free()` after reading it.

---

### `orc_slice_multi`

```c
int orc_slice_multi(
    const void* all_stl, int all_stl_len,
    const int*  offsets,  int n_files,
    char**      out_gcode, int* out_len
);
```

Arrange multiple STL files on a single plate and slice them to one G-code file.
Requires `orc_init` to have been called first.

**Parameters**

- `all_stl` — concatenation of all STL file bytes on the WASM heap
- `all_stl_len` — total byte length of the concatenated buffer
- `offsets` — `int32` array of length `n_files * 2`: `[start0, len0, start1, len1, …]`
- `n_files` — number of STL files
- `out_gcode` — on success, written with the address of the output G-code buffer
- `out_len` — on success, written with the byte length of the output buffer

**Returns** — same error code convention as `orc_slice`.

**Arrangement** uses OrcaSlicer's `arrange_objects()` (libnest2d + NLopt, single-threaded) with a 2 mm minimum gap. Objects that cannot fit on the bed are placed at bed centre rather than triggering an error. For circular beds (`bed_shape: "circle"`), the arrangement boundary is the largest inscribed square (half-side = radius / √2).

**Memory:** caller must free `*out_gcode` with `orc_free()` after reading it.

---

### `orc_obj_to_stl`

```c
int orc_obj_to_stl(
    const char* obj_data, int obj_len,
    char**      out_stl,  int* out_len
);
```

Convert an OBJ file to binary STL using OrcaSlicer's native parser. Does **not** require `orc_init`.

**Parameters**

- `obj_data` — pointer to raw OBJ file bytes on the WASM heap
- `obj_len` — byte length of the OBJ data
- `out_stl` — on success, written with the address of the output STL buffer
- `out_len` — on success, written with the byte length of the output STL

**Returns**

| Code | Meaning |
|---|---|
| `0` | Success |
| `-1` | Invalid arguments (null pointer or zero length) |
| `-3` | Could not write OBJ to MEMFS |
| `-4` | OBJ load failed (invalid or unsupported format) |
| `-5` | OBJ contains no printable geometry |
| `-8` | Internal STL export failed |
| `-9` | Unexpected C++ exception |

**Supported OBJ features:** triangle and quad faces (quads auto-triangulated), multiple named objects (merged into one mesh), `v/vt/vn` vertex format variants.  
**Ignored:** MTL material files, vertex colours, NURBS curves/surfaces.

**Memory:** caller must free `*out_stl` with `orc_free()` after reading it.

---

### `orc_cad_to_stl`

```c
int orc_cad_to_stl(
    const char* cad_data, int cad_len,
    char**      out_stl,  int* out_len
);
```

Convert a STEP file to binary STL using the OCCT 7.8.1 reader compiled into `slicer.wasm`. Does **not** require `orc_init`.

**Parameters**

- `cad_data` — pointer to raw STEP file bytes on the WASM heap
- `cad_len` — byte length of the STEP data
- `out_stl` — on success, written with the address of the output STL buffer
- `out_len` — on success, written with the byte length of the output STL

**Returns**

| Code | Meaning |
|---|---|
| `0` | Success |
| `-1` | Invalid arguments (null pointer or zero length) |
| `-3` | Could not write STEP data to MEMFS |
| `-4` | STEP load failed (bad file or unsupported STEP feature) |
| `-5` | File contains no printable geometry |
| `-8` | STL export failed |
| `-9` | Unexpected C++ exception |

**Notes**

- Only STEP (`.step`, `.stp`) is accepted. IGES is not supported — `STEPCAFControl_Reader` does not read IGES.
- Tessellation uses OrcaSlicer defaults: linear deflection `0.003 mm`, angular deflection `0.5°`.
- All STEP shapes are merged into a single STL mesh.

**Memory:** caller must free `*out_stl` with `orc_free()` after reading it.

---

### `orc_free`

```c
void orc_free(void* ptr);
```

Free a buffer allocated by `orc_slice`, `orc_slice_multi`, `orc_obj_to_stl`, or `orc_cad_to_stl`. Do **not** use `_free` for these buffers — they are `malloc`'d by the C++ bridge.

---

### `orc_decode_exception`

```c
const char* orc_decode_exception(void* unused);
```

Return the last error message stored by the C++ bridge as a null-terminated UTF-8 string. The pointer is valid only until the next `orc_*` call.

**Usage pattern**

```typescript
const rc = module._orc_slice(stlPtr, stlLen, ptrPtr, lenPtr)
if (rc !== 0) {
  const errPtr = module._orc_decode_exception(0)
  const message = module.UTF8ToString(errPtr)
  throw new Error(`orc_slice (${rc}): ${message}`)
}
```

Called with argument `0` (the `unused` parameter is ignored by the implementation).

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

// Read a C string of known byte length
const str = module.UTF8ToString(ptr, byteLength)

// Free memory you allocated with _malloc
module._free(ptr)

// Free memory returned by orc_slice / orc_obj_to_stl / orc_cad_to_stl
module._orc_free(ptr)
```

!!! warning "orc_free vs _free"
    Buffers **returned** by the C bridge (`orc_slice`, `orc_slice_multi`, `orc_obj_to_stl`, `orc_cad_to_stl`) must be freed with `_orc_free`.  
    Buffers you allocated yourself with `_malloc` must be freed with `_free`.

---

## TypeScript interface

```typescript
interface OrcaModule {
  // Emscripten heap utilities
  _malloc(size: number): number
  _free(ptr: number): void
  setValue(ptr: number, value: number, type: 'i32' | 'i64' | 'float' | 'double'): void
  getValue(ptr: number, type: 'i32' | 'i64' | 'float' | 'double'): number
  UTF8ToString(ptr: number, length?: number): string
  HEAPU8: Uint8Array

  // OrcaSlicer bridge
  _orc_init(configPtr: number, len: number): number
  _orc_slice(
    stlPtr: number, stlLen: number,
    outPtrPtr: number, outLenPtr: number,
  ): number
  _orc_slice_multi(
    dataPtr: number, dataLen: number,
    offsetsPtr: number, nFiles: number,
    outPtrPtr: number, outLenPtr: number,
  ): number
  _orc_obj_to_stl(
    objPtr: number, objLen: number,
    outPtrPtr: number, outLenPtr: number,
  ): number
  _orc_cad_to_stl(
    cadPtr: number, cadLen: number,
    outPtrPtr: number, outLenPtr: number,
  ): number
  _orc_free(ptr: number): void
  _orc_decode_exception(unused: number): number  // returns ptr to C string
}
```

---

## Worker message protocol

Communication between the main thread and `slicer.worker.ts`.

### Main → Worker

```typescript
// Tell the worker where to fetch the engine
{ type: 'LOAD_WASM'; url: string }   // url points to slicer.js

// Slice a single STL file
{
  type: 'SLICE'
  stl: ArrayBuffer      // transferred (zero-copy)
  config: OrcaConfig
}

// Arrange N STL files on one plate and slice together
{
  type: 'SLICE_MULTI'
  stls: ArrayBuffer[]   // all transferred (zero-copy)
  config: OrcaConfig
}

// Convert an OBJ file to binary STL
{
  type: 'OBJ_TO_STL'
  obj: ArrayBuffer      // transferred (zero-copy)
  filename: string      // echoed back in the response for tracking
}

// Convert a STEP file to binary STL
{
  type: 'CAD_TO_STL'
  cad: ArrayBuffer      // transferred (zero-copy)
  filename: string      // echoed back in the response for tracking
}
```

### Worker → Main

```typescript
// Worker script evaluated, ready to receive messages
{ type: 'WORKER_READY' }

// WASM module fully loaded and ready
{ type: 'WASM_LOADED' }

// WASM failed to load
{ type: 'WASM_ERROR'; message: string }

// Single-file slicing finished
{ type: 'SLICE_COMPLETE'; gcode: string }

// Single-file slicing failed
{ type: 'SLICE_ERROR'; code: number; message: string }

// Plate slicing finished
{ type: 'SLICE_MULTI_COMPLETE'; gcode: string }

// Plate slicing failed
{ type: 'SLICE_MULTI_ERROR'; code: number; message: string }

// OBJ → STL conversion finished
{ type: 'OBJ_STL_COMPLETE'; stl: ArrayBuffer; filename: string }

// OBJ → STL conversion failed
{ type: 'OBJ_STL_ERROR'; message: string; filename: string }

// STEP → STL conversion finished
{ type: 'CAD_STL_COMPLETE'; stl: ArrayBuffer; filename: string }

// STEP → STL conversion failed
{ type: 'CAD_STL_ERROR'; message: string; filename: string }
```

**Ordering notes:**

- `LOAD_WASM` must be sent before any other message type.
- Slice and conversion requests sent before `WASM_LOADED` are queued inside the worker and dispatched automatically once the engine is ready.
- `SLICE` requests are last-wins when queued (only one can be pending). `OBJ_TO_STL` and `CAD_TO_STL` requests are queued independently (FIFO).

---

## Config JSON schema

Passed as the body of `orc_init`. All fields are optional — omitted fields use OrcaSlicer built-in defaults.

```typescript
interface OrcaConfig {
  // Bed geometry — used for model centering and auto-arrangement
  bed_size_x?: number              // print bed width  (mm); default 256
  bed_size_y?: number              // print bed depth  (mm); default 256
  bed_shape?: 'rectangle'          // cartesian/CoreXY (default)
            | 'circle'             // delta / round bed

  // Machine
  printer_model?: string           // e.g. "BambuLab X1C"
  nozzle_diameter?: number         // mm, e.g. 0.4
  printable_height?: number        // maximum model height in mm

  // Filament
  filament_type?: string           // 'PLA' | 'PETG' | 'ABS' | 'TPU' | ...
  nozzle_temperature?: number      // °C
  bed_temperature?: number         // °C
  fan_min_speed?: number           // 0–100 %

  // Quality
  layer_height?: number            // mm
  initial_layer_height?: number    // mm
  top_shell_layers?: number
  bottom_shell_layers?: number
  wall_loops?: number

  // Infill
  sparse_infill_density?: number   // 0–100
  sparse_infill_pattern?: InfillPattern

  // Speed  (mm/s)
  default_speed?: number
  outer_wall_speed?: number
  initial_layer_speed?: number
  travel_speed?: number

  // Supports
  enable_support?: boolean
  support_type?: SupportType

  // Adhesion
  brim_width?: number              // mm

  // Surface quality
  seam_position?: SeamPosition
  fuzzy_skin?: FuzzySkin
  fuzzy_skin_thickness?: number    // mm; 0.05–2 (default 0.3)
  fuzzy_skin_point_dist?: number   // mm; 0.1–5 (default 0.8)
  enable_ironing?: boolean

  // Escape hatch — forward any OrcaSlicer key verbatim
  // Values must be strings (OrcaSlicer's internal serialisation format)
  _passthrough?: Record<string, string>
}

type InfillPattern =
  | 'grid' | 'gyroid' | 'honeycomb' | 'triangles'
  | 'cubic' | 'lightning' | 'rectilinear'

type SupportType =
  | 'normal(auto)' | 'normal(manual)'
  | 'tree(auto)'   | 'tree(manual)'

type SeamPosition = 'aligned' | 'nearest' | 'back' | 'random'

type FuzzySkin = 'none' | 'external' | 'all'
```

### `_passthrough` field

Any OrcaSlicer config key not covered by the typed fields above can be forwarded verbatim. Values must be strings encoded as OrcaSlicer stores them (numbers as `"0.2"`, booleans as `"1"` / `"0"`):

```json
{
  "layer_height": 0.2,
  "_passthrough": {
    "max_layer_height": "0.28",
    "min_layer_height": "0.07",
    "enable_overhang_speed": "1"
  }
}
```

Unknown or incompatible keys in `_passthrough` are silently ignored by the C++ bridge.

---

## G-code statistics

`parseGcodeStats` (internal utility, called by the UI's `SlicePanel`) returns:

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

Both the first 100 kB (up to 300 lines) and the last 30 kB (up to 200 lines) of the G-code string are scanned — OrcaSlicer may write summary comments at either the beginning or the end depending on the post-processing path. `layers` falls back to counting `;LAYER_CHANGE` markers in the full file when the `; total layers count` comment is absent.

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

The returned `stlBytes` can be passed directly to `orc_slice` (or posted to the worker as a `SLICE` message). The returned `config` contains any printer/filament/process settings extracted from the 3MF's embedded profiles and can be merged with your base config before calling `orc_init`.
