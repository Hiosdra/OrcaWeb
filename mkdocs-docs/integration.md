# Integration Guide

This guide is for developers who want to embed the OrcaSlicer WASM engine in their own application — a web app, a Node.js backend, a CI pipeline, or any environment that can execute WebAssembly.

---

## What the engine provides

| Capability | Function |
|---|---|
| Slice STL → G-code | `orc_init` + `orc_slice` |
| Slice multiple STLs on one plate → G-code | `orc_init` + `orc_slice_multi` |
| Convert OBJ → binary STL | `orc_obj_to_stl` |
| Convert STEP → binary STL | `orc_cad_to_stl` |

The engine is **stateless between slicing calls** except for the config set by `orc_init`. It is **single-threaded** — use a Web Worker (browser) or a Worker Thread (Node.js) to avoid blocking the event loop.

---

## Obtaining the WASM artifacts

The two required files are published as an immutable GitHub Release: the
first build for a given OrcaSlicer version is tagged `wasm-v2.4.0`; a later
fix to `orca-wasm/` for the same OrcaSlicer version publishes
`wasm-v2.4.0-patchN` as a new release instead of overwriting the previous
one. `scripts/download-wasm.mjs` and `deploy.yml` both resolve whichever tag
has the highest patch number automatically.

| File | Size | Purpose |
|---|---|---|
| `slicer.wasm` | ~29 MB | Compiled engine (OrcaSlicer v2.4.0 + OCCT 7.8.1) |
| `slicer.js` | ~210 KB | Emscripten JS glue (CommonJS IIFE) |

**Download via the provided script:**

```bash
node scripts/download-wasm.mjs   # saves to public/wasm/
```

**Or fetch manually from GitHub Releases** and serve the two files from any static host.

---

## Quick start — browser (Web Worker)

Running the engine in a Web Worker keeps the main thread free while the ~29 MB WASM module loads and while slicing runs.

### 1. Load the engine in a worker

```typescript
// slicer.worker.ts
import { loadOrcaModule, sliceStl } from './wasm-loader'

let module: Awaited<ReturnType<typeof loadOrcaModule>> | null = null

self.addEventListener('message', async (e) => {
  const { type } = e.data

  if (type === 'LOAD') {
    module = await loadOrcaModule()   // no argument — uses built-in WASM_BASE
    self.postMessage({ type: 'READY' })
    return
  }

  if (type === 'SLICE' && module) {
    const { stl, config } = e.data
    try {
      const gcode = sliceStl(module, new Uint8Array(stl), JSON.stringify(config))
      self.postMessage({ type: 'DONE', gcode })
    } catch (err) {
      self.postMessage({ type: 'ERROR', message: String(err) })
    }
  }
})
```

### 2. Use it from the main thread

```typescript
const worker = new Worker(new URL('./slicer.worker.ts', import.meta.url), {
  type: 'module',
})

worker.postMessage({ type: 'LOAD' })

worker.onmessage = async (e) => {
  if (e.data.type === 'READY') {
    console.log('Engine ready')

    // Slice a file
    const stlBytes: ArrayBuffer = await fetch('/model.stl').then(r => r.arrayBuffer())
    worker.postMessage(
      { type: 'SLICE', stl: stlBytes, config: { layer_height: 0.2 } },
      [stlBytes],   // transfer ownership — zero-copy
    )
  }

  if (e.data.type === 'DONE') {
    console.log('G-code length:', e.data.gcode.length)
  }
}
```

---

## Quick start — Node.js (Worker Thread)

The WASM engine runs under Node.js without changes. Use `worker_threads` instead of `Web Worker`.

```typescript
// slicer.mts
import { workerData, parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Load Emscripten CommonJS glue
const require = createRequire(import.meta.url)
const jsText = readFileSync('./wasm/slicer.js', 'utf8')
const wasmBinary = readFileSync('./wasm/slicer.wasm').buffer

// Eval the IIFE so OrcaModule factory is available
const fn = new Function('module', 'exports', jsText + '\nreturn OrcaModule')
const factory = fn({}, {})

const module = await factory({ wasmBinary })

// Slice
const stl = readFileSync('./model.stl')
const configJson = JSON.stringify({ layer_height: 0.2, nozzle_diameter: 0.4 })

const enc = new TextEncoder()
const configBytes = enc.encode(configJson)
const configPtr = module._malloc(configBytes.length)
module.HEAPU8.set(configBytes, configPtr)
const initCode = module._orc_init(configPtr, configBytes.length)
module._free(configPtr)
if (initCode !== 0) throw new Error(`orc_init failed: ${initCode}`)

const stlPtr = module._malloc(stl.length)
module.HEAPU8.set(stl, stlPtr)  // Buffer extends Uint8Array — pass directly to avoid pool-offset bug
const ptrPtr = module._malloc(4)
const lenPtr = module._malloc(4)
const rc = module._orc_slice(stlPtr, stl.length, ptrPtr, lenPtr)
module._free(stlPtr)
if (rc !== 0) throw new Error(`orc_slice failed: ${rc} — ${module.UTF8ToString(module._orc_decode_exception(0))}`)

const gcodePtr = module.getValue(ptrPtr, 'i32')
const gcodeLen = module.getValue(lenPtr, 'i32')
const gcode = module.UTF8ToString(gcodePtr, gcodeLen)
module._orc_free(gcodePtr)
module._free(ptrPtr)
module._free(lenPtr)

console.log('G-code lines:', gcode.split('\n').length)
```

---

## Loading `slicer.js` without a bundler

Emscripten emits a CommonJS IIFE (`var OrcaModule = ...`). Browsers cannot `import()` it directly. The standard pattern used by this project:

```typescript
async function loadEngine(baseUrl: string) {
  const [jsText, wasmBinary] = await Promise.all([
    fetch(`${baseUrl}/slicer.js`).then(r => r.text()),
    fetch(`${baseUrl}/slicer.wasm`).then(r => r.arrayBuffer()),
  ])

  // Append an ES default export so the IIFE becomes importable
  const blob = new Blob(
    [`${jsText}\nexport default OrcaModule;`],
    { type: 'application/javascript' },
  )
  const url = URL.createObjectURL(blob)

  try {
    const { default: factory } = await import(/* @vite-ignore */ url)
    return factory({ wasmBinary, locateFile: (p: string) => `${baseUrl}/${p}` })
  } finally {
    URL.revokeObjectURL(url)
  }
}
```

The `wasmBinary` option tells Emscripten not to re-fetch `slicer.wasm` — the binary is already in memory.

---

## Slicing an STL file

```typescript
import { sliceStl } from './lib/wasm-loader'

// module = loaded OrcaModule (see above)
// stlData = Uint8Array of the .stl file (binary or ASCII both accepted)
// configJson = JSON string of OrcaConfig fields

const gcode: string = sliceStl(module, stlData, configJson)
```

Under the hood, `sliceStl` calls `orc_init` then `orc_slice` and handles WASM heap allocation / deallocation. It throws `OrcaSliceError` on failure.

### Minimal config

```json
{
  "layer_height": 0.2,
  "nozzle_diameter": 0.4,
  "bed_size_x": 256,
  "bed_size_y": 256
}
```

All fields are optional — unset fields use OrcaSlicer built-in defaults.

---

## Slicing multiple files onto one plate

`orc_slice_multi` arranges all objects automatically using OrcaSlicer's `arrange_objects()` (libnest2d + NLopt) with a 2 mm gap. Objects that don't fit are placed at bed centre instead of failing.

```typescript
import { sliceMultiStl } from './lib/wasm-loader'

// stls = array of Uint8Array, one per file
// offsets = Int32Array with pairs [start0, len0, start1, len1, ...]
// built by concatenating all stls into one buffer

const totalLen = stls.reduce((s, a) => s + a.length, 0)
const combined = new Uint8Array(totalLen)
const offsets = new Int32Array(stls.length * 2)
let pos = 0
for (let i = 0; i < stls.length; i++) {
  combined.set(stls[i], pos)
  offsets[i * 2]     = pos
  offsets[i * 2 + 1] = stls[i].length
  pos += stls[i].length
}

const gcode = sliceMultiStl(module, combined, offsets, stls.length, configJson)
```

---

## Converting OBJ to STL

`orc_obj_to_stl` does **not** require `orc_init`. Call it standalone.

```typescript
import { objToStl } from './lib/wasm-loader'

const stlBytes: Uint8Array = objToStl(module, objData)
// stlBytes is binary STL — feed it to orc_slice or preview in a 3D viewer
```

**Supported OBJ features:** triangle and quad faces (quads auto-triangulated), multiple named objects (merged into one mesh), `v/vt/vn` vertex format variants.  
**Ignored:** MTL material files, vertex colours, NURBS curves/surfaces.

---

## Converting STEP to STL

`orc_cad_to_stl` reads STEP files using OrcaSlicer's embedded OCCT 7.8.1 reader. Does **not** require `orc_init`.

```typescript
import { cadToStl } from './lib/wasm-loader'

const stlBytes: Uint8Array = cadToStl(module, stepData)
// stlBytes is binary STL
```

!!! note "IGES is not supported"
    OrcaSlicer's STEP reader (`STEPCAFControl_Reader`) does not accept IGES files. Only `.step`/`.stp` extensions are supported.

Tessellation parameters used: linear deflection `0.003 mm`, angular deflection `0.5°` (OrcaSlicer defaults).

---

## Error handling

All four helper functions (`sliceStl`, `sliceMultiStl`, `objToStl`, `cadToStl`) throw `OrcaSliceError` on failure.

```typescript
import { OrcaSliceError } from './lib/wasm-loader'

try {
  const gcode = sliceStl(module, stlData, configJson)
} catch (err) {
  if (err instanceof OrcaSliceError) {
    console.error(`Slice failed (code ${err.code}): ${err.message}`)
  }
}
```

`OrcaSliceError.message` is the human-readable message returned by `orc_decode_exception` (last error stored by the C++ bridge), with a fallback to a code-based description.

When calling C functions directly, retrieve the last error with:

```typescript
const errPtr = module._orc_decode_exception(0)
const message = module.UTF8ToString(errPtr)
```

---

## Using the built-in Worker message protocol

If you don't want to write your own worker, use the existing `slicer.worker.ts` via the `worker-singleton.ts` module. This is how the OrcaWeb app itself works.

```typescript
import { getWorker, addWorkerListener } from './lib/worker-singleton'

// Start loading (only happens once per session)
const worker = getWorker()

// Listen for responses
const unsub = addWorkerListener((msg) => {
  switch (msg.type) {
    case 'WASM_LOADED':
      console.log('Engine ready')
      break
    case 'SLICE_COMPLETE':
      console.log('G-code:', msg.gcode.slice(0, 200))
      unsub()
      break
    case 'SLICE_ERROR':
      console.error(msg.message)
      unsub()
      break
  }
})

// Wait for WASM_LOADED before sending SLICE
worker.postMessage({
  type: 'SLICE',
  stl: stlBuffer,           // ArrayBuffer — transferred zero-copy
  config: { layer_height: 0.2 },
}, [stlBuffer])
```

See the [API Reference → Worker message protocol](api-reference.md#worker-message-protocol) for the full list of message types.

---

## Config reference (key fields)

See [API Reference → Config JSON schema](api-reference.md#config-json-schema) for the full schema. The most commonly set fields:

```typescript
{
  // Bed geometry — used for model centering
  bed_size_x: 256,          // mm
  bed_size_y: 256,          // mm
  bed_shape: 'rectangle',   // or 'circle' for delta printers

  // Nozzle
  nozzle_diameter: 0.4,     // mm

  // Layer
  layer_height: 0.2,        // mm
  initial_layer_height: 0.2,

  // Filament
  filament_type: 'PLA',
  nozzle_temperature: 220,  // °C
  bed_temperature: 60,      // °C

  // Infill
  sparse_infill_density: 15,        // %
  sparse_infill_pattern: 'grid',

  // Supports
  enable_support: false,

  // Pass-through for any OrcaSlicer key not listed above
  _passthrough: {
    max_layer_height: '0.28',
    min_layer_height: '0.07',
  },
}
```

### `_passthrough` field

Any OrcaSlicer config key not covered by `OrcaConfig` can be forwarded verbatim via `_passthrough`. Values must be strings (the same format OrcaSlicer stores them internally):

```typescript
_passthrough: {
  fuzzy_skin: 'external',
  fuzzy_skin_thickness: '0.3',
  fuzzy_skin_point_dist: '0.8',
}
```

---

## Memory management (direct C API)

The WASM heap is managed by Emscripten. All input buffers must be copied onto the heap before calling C functions, and all output buffers must be freed with `orc_free`.

```typescript
// Allocate + write
const ptr = module._malloc(bytes.length)
module.HEAPU8.set(bytes, ptr)

// Read an int pointer
const innerPtr = module.getValue(ptrPtr, 'i32')
const length   = module.getValue(lenPtr, 'i32')

// Read a C string
const str = module.UTF8ToString(ptr)             // null-terminated
const str = module.UTF8ToString(ptr, length)     // known length

// Free C-allocated buffers (returned by orc_slice / orc_obj_to_stl / orc_cad_to_stl)
module._orc_free(innerPtr)

// Free JS-allocated buffers (allocated with _malloc)
module._free(ptr)
```

!!! warning "orc_free vs _free"
    Use `module._orc_free(ptr)` for buffers **returned** by `orc_slice`, `orc_slice_multi`, `orc_obj_to_stl`, and `orc_cad_to_stl`. These are `malloc`'d by the C++ bridge.  
    Use `module._free(ptr)` for buffers you allocated yourself with `module._malloc()`.

---

## Bed geometry

`bed_size_x` and `bed_size_y` are used to center models on the virtual bed. `bed_shape` affects how `orc_slice_multi` bounds the auto-arrangement area:

| `bed_shape` | Arrangement boundary |
|---|---|
| `rectangle` (default) | Full `bed_size_x × bed_size_y` rectangle |
| `circle` | Largest square inscribed in the circle (side = radius × √2) |

For circular beds, the effective printable area used by the arranger is the inscribed square — objects are never placed in the corners that fall outside the circle.

---

## Complete TypeScript example (browser, no framework)

```typescript
// Module-level cache — engine is fetched and compiled only once
let _enginePromise: Promise<any> | null = null

function loadEngine(wasmBase: string): Promise<any> {
  if (!_enginePromise) {
    _enginePromise = (async () => {
      const [jsText, wasmBinary] = await Promise.all([
        fetch(`${wasmBase}/slicer.js`).then(r => r.text()),
        fetch(`${wasmBase}/slicer.wasm`).then(r => r.arrayBuffer()),
      ])
      const blob = new Blob([`${jsText}\nexport default OrcaModule;`], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        const { default: factory } = await import(url)
        return factory({ wasmBinary })
      } finally {
        URL.revokeObjectURL(url)
      }
    })()
  }
  return _enginePromise
}

// Slice a single file (engine is reused across calls)
async function sliceFile(stlBytes: Uint8Array, config: object): Promise<string> {
  const module = await loadEngine('/wasm')

  const enc = new TextEncoder()
  const cfgBytes = enc.encode(JSON.stringify(config))
  const cfgPtr = module._malloc(cfgBytes.length)
  module.HEAPU8.set(cfgBytes, cfgPtr)
  const initCode = module._orc_init(cfgPtr, cfgBytes.length)
  module._free(cfgPtr)
  if (initCode !== 0) {
    throw new Error(`orc_init: ${module.UTF8ToString(module._orc_decode_exception(0))}`)
  }

  const stlPtr = module._malloc(stlBytes.length)
  module.HEAPU8.set(stlBytes, stlPtr)
  const ptrPtr = module._malloc(4)
  const lenPtr = module._malloc(4)

  const rc = module._orc_slice(stlPtr, stlBytes.length, ptrPtr, lenPtr)
  module._free(stlPtr)

  if (rc !== 0) {
    module._free(ptrPtr)
    module._free(lenPtr)
    throw new Error(`orc_slice (${rc}): ${module.UTF8ToString(module._orc_decode_exception(0))}`)
  }

  const gcodePtr = module.getValue(ptrPtr, 'i32')
  const gcodeLen = module.getValue(lenPtr, 'i32')
  const gcode = module.UTF8ToString(gcodePtr, gcodeLen)

  module._orc_free(gcodePtr)
  module._free(ptrPtr)
  module._free(lenPtr)

  return gcode
}

// Usage
const stl = await fetch('/model.stl').then(r => r.arrayBuffer())
const gcode = await sliceFile(new Uint8Array(stl), {
  layer_height: 0.2,
  nozzle_diameter: 0.4,
  bed_size_x: 256,
  bed_size_y: 256,
  nozzle_temperature: 220,
  bed_temperature: 60,
})
console.log(gcode.slice(0, 500))
```
