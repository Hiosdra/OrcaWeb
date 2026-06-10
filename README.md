# OrcaWeb — Browser Slicer

OrcaSlicer compiled to WebAssembly. Slice STL files directly in the browser — no server, no upload, 100% private.

**[Live app →](https://hiosdra.github.io/OrcaWeb/app/)**  |  **[Documentation →](https://hiosdra.github.io/OrcaWeb/docs/)**

## Features

- Full OrcaSlicer engine (WASM) — same slicing quality as the desktop app
- 3D model preview + G-code layer visualiser side-by-side
- Import OrcaSlicer profiles (.json) from your desktop installation
- Built-in presets: Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4
- Node.js CLI for batch/headless slicing

## Quick start (local dev)

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
npm install
node scripts/download-wasm.mjs   # ~150 MB, one-time download
npm run dev
```

The download script fetches pre-built WASM artifacts into `public/wasm/`.
Those files are gitignored (too large for git).

## Architecture

```
Browser
├── React UI (main thread)
│   ├── ModelViewer   — Three.js, model on print bed (real mm scale)
│   ├── GcodeViewer   — toolpaths layer by layer with slider
│   └── SettingsPanel — presets + OrcaSlicer profile import
│
└── Web Worker (slicer.worker.ts)
    └── OrcaSlicer WASM module
        ├── slicer.js    (~1.5 MB)
        ├── slicer.wasm  (~8 MB)
        └── slicer.data  (~150 MB, preloaded OrcaSlicer profile bundle)
```

### WASM loading

In CI the WASM artifacts are downloaded and included directly in the GitHub Pages
deployment, so they are served from the **same origin** as the app — no CORS issues.

`slicer.data` is 150 MB, which exceeds git's 100 MB per-file limit, so it is
split into two chunks (`slicer.data.part0`, `slicer.data.part1`).  The worker
transparently reassembles them via a `fetch` intercept before Emscripten
initialises.  In local dev the single `slicer.data` file is used instead.

### Self-contained WASM build (v2.3.2)

`orca-wasm/` contains a clean-room Emscripten build pipeline targeting
OrcaSlicer **v2.3.2** (the latest stable release as of this writing):

```
orca-wasm/
├── orca/           ← git submodule: SoftFever/OrcaSlicer@v2.3.2
├── bridge/         ← C++ bridge: orc_init / orc_slice / orc_free
├── wasm/shims/     ← sequential TBB stubs (WASM is single-threaded)
├── patches/        ← Python patcher for WASM compatibility
├── deps/           ← Boost / GMP / MPFR / CGAL build scripts
└── scripts/        ← build.sh end-to-end build script
```

Build the WASM module locally:
```bash
source /path/to/emsdk/emsdk_env.sh
cd orca-wasm && ./scripts/build.sh
```

Or trigger the `Build WASM` GitHub Actions workflow manually to produce a
`wasm-v2.3.2` release with the compiled artifacts.

See [`orca-wasm/README.md`](orca-wasm/README.md) for the full build guide.

## CLI

```bash
npm run cli -- slice model.stl -o output.gcode
npm run cli -- profiles
```

## Stack

| | |
|---|---|
| UI | React 18, TypeScript, Tailwind CSS |
| 3D | Three.js (STLLoader, OrbitControls) |
| Bundler | Vite 5 |
| WASM | OrcaSlicer v2.3.2 via Emscripten (own build) |
| Docs | Material for MkDocs |
| CI/CD | GitHub Actions → GitHub Pages |

## Licence

OrcaSlicer source is © 2022 SoftFever and contributors, AGPL-3.0.  
OrcaWeb UI, CLI, bridge, and build infrastructure are MIT.
