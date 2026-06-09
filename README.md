# OrcaWeb — Browser Slicer

OrcaSlicer v2.3.1 compiled to WebAssembly. Slice STL files directly in the browser — no server, no upload, 100% private.

**[Documentation site →](https://hiosdra.github.io/OrcaWeb/)**

## Features

- Full OrcaSlicer engine (WASM) — same quality as the desktop app
- 3D model preview + G-code layer visualiser side-by-side
- Import OrcaSlicer profiles (.json) from your desktop installation
- Built-in presets: Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4
- Node.js CLI for batch/headless slicing

## Quick start

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
npm install
node scripts/download-wasm.mjs   # ~150 MB, one-time
npm run dev
```

> **Note:** WASM artifacts (`public/wasm/`) are not in the repo — too large for GitHub. The download script fetches them from [orcaslicer-wasm releases](https://github.com/allanwrench28/orcaslicer-wasm/releases).

## CLI

```bash
npm run cli -- slice model.stl -o output.gcode
npm run cli -- profiles
```

## Architecture

```
Browser
├── React UI (main thread)
│   ├── ModelViewer   — Three.js, STL on print bed (real mm scale)
│   ├── GcodeViewer   — toolpaths layer by layer with slider
│   └── SettingsPanel — presets + OrcaSlicer profile import
│
└── Web Worker
    ├── slicer.worker.ts  — isolates WASM from UI thread
    └── public/wasm/
        ├── slicer.js     (1.2 MB)
        ├── slicer.wasm   (6.4 MB)
        └── slicer.data   (144 MB)  ← gitignored, download separately
```

See [`docs/06-architecture.md`](docs/06-architecture.md) for the full breakdown.

## Stack

| | |
|---|---|
| UI | React 18, TypeScript, Tailwind CSS |
| 3D | Three.js (STLLoader, OrbitControls) |
| Bundler | Vite 5 |
| WASM | OrcaSlicer v2.3.1 via Emscripten |

## License

MIT
