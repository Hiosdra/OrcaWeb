# CLI

OrcaWeb includes a Node.js command-line interface for headless and batch slicing using the same WASM engine as the browser.

## Installation

The CLI is part of the main repository. After cloning and running `npm install`, it is available via:

```bash
npm run cli -- <command> [options]
```

## Commands

### `setup`

Download WASM artifacts to `public/wasm/`.

```bash
npm run cli -- setup
```

Equivalent to `node scripts/download-wasm.mjs`. Downloads `slicer.js`, `slicer.wasm`, and `slicer.data` from the [orcaslicer-wasm](https://github.com/allanwrench28/orcaslicer-wasm) GitHub release.

---

### `slice`

Slice an STL file and write G-code.

```bash
npm run cli -- slice <file> [options]
```

**Arguments**

| Argument | Description |
|----------|-------------|
| `file` | Path to the input `.stl` file |

**Options**

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <path>` | `<input>.gcode` | Output G-code file path |
| `-p, --preset <name>` | `standard` | Quality preset: `draft`, `standard`, `fine` |
| `--printer <name>` | `Generic 0.4` | Printer preset name |
| `--filament <type>` | `PLA` | Filament type: `PLA`, `PETG`, `ABS`, `TPU` |
| `--layer-height <mm>` | preset default | Layer height in mm |
| `--infill <percent>` | preset default | Infill density 0–100 |

**Example**

```bash
npm run cli -- slice bracket.stl -o bracket.gcode \
  --printer "Bambu Lab X1C" \
  --filament PETG \
  --preset fine
```

---

### `profiles`

List all available built-in presets.

```bash
npm run cli -- profiles
```

Output includes printer presets, filament types, and quality presets with their key settings.

## Node.js API

The CLI exposes the slicer as a Node.js module for use in scripts:

```typescript
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'

const require = createRequire(import.meta.url)
const OrcaModule = require('./public/wasm/slicer.js')

const module = await OrcaModule({
  wasmBinary: readFileSync('./public/wasm/slicer.wasm').buffer,
  locateFile: (p: string) => `./public/wasm/${p}`,
})

// Initialise with config
const config = JSON.stringify({ layer_height: 0.2, filament_type: 'PLA' })
const configBuf = Buffer.from(config, 'utf8')
const configPtr = module._malloc(configBuf.length)
module.HEAPU8.set(configBuf, configPtr)
const initResult = module._orc_init(configPtr, configBuf.length)
module._free(configPtr)

// Slice
const stl = readFileSync('model.stl')
const stlPtr = module._malloc(stl.length)
module.HEAPU8.set(stl, stlPtr)
const outPtrPtr = module._malloc(4)
const outLenPtr = module._malloc(4)
const code = module._orc_slice(stlPtr, stl.length, outPtrPtr, outLenPtr)
module._free(stlPtr)

if (code === 0) {
  const outPtr = module.getValue(outPtrPtr, 'i32')
  const outLen = module.getValue(outLenPtr, 'i32')
  const gcode = module.UTF8ToString(outPtr)
  writeFileSync('output.gcode', gcode)
  module._free(outPtr)
}

module._free(outPtrPtr)
module._free(outLenPtr)
```

## Requirements

- Node.js 18+
- WASM artifacts in `public/wasm/` (run `setup` first)
