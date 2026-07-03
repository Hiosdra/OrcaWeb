# OrcaWeb — Browser Slicer

OrcaSlicer compiled to WebAssembly. Slice STL files directly in the browser — no server, no upload, 100% private.

**[Live app →](https://hiosdra.github.io/OrcaWeb/app/)**  |  **[Documentation →](https://hiosdra.github.io/OrcaWeb/docs/)**

## Features

- Full OrcaSlicer engine (WASM) — same slicing quality as the desktop app
- 3D model preview + G-code layer visualiser side-by-side
- Import OrcaSlicer profiles (.json) from your desktop installation
- Built-in presets: Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4

## Quick start (local dev)

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
npm install
node scripts/download-wasm.mjs   # ~9 MB, one-time download
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
        └── slicer.wasm  (~7.5 MB)
```

No `slicer.data` — the headless flat-config slicer never reads `orca/resources`
at runtime, so the 200 MB preload file was eliminated entirely (~9 MB total cold load).

### WASM loading

In CI the WASM artifacts are downloaded from the latest immutable
`wasm-v2.4.0` (optionally `-patchN`) GitHub Release and embedded directly in
the GitHub Pages deployment, so they are served from the **same origin** as the app —
no CORS issues.

### Self-contained WASM build (v2.4.0)

`orca-wasm/` contains a clean-room Emscripten build pipeline targeting
OrcaSlicer **v2.4.0** (the latest stable release as of this writing):

```
orca-wasm/
├── orca/           ← git submodule: SoftFever/OrcaSlicer@v2.4.0
├── bridge/         ← C++ bridge: orc_init / orc_slice / orc_free
├── wasm/shims/     ← sequential TBB stubs (WASM is single-threaded)
├── patches/        ← Python patcher for WASM compatibility
└── scripts/        ← build-local-wsl.sh end-to-end build script
```

Build the WASM module locally (Linux / macOS / WSL2 — see
[`mkdocs-docs/wasm-build.md`](mkdocs-docs/wasm-build.md) for full setup):
```bash
# from the repo root, not orca-wasm/
./orca-wasm/scripts/build-local-wsl.sh
```

Or trigger the `Build WASM` GitHub Actions workflow manually to publish a new
`wasm-v2.4.0` (optionally `-patchN`) release with the compiled artifacts —
releases are immutable, so a rebuild never overwrites a previous one (see
[`mkdocs-docs/wasm-build.md`](mkdocs-docs/wasm-build.md)).

See [`orca-wasm/README.md`](orca-wasm/README.md) for the full build guide.

## Stack

| | |
|---|---|
| UI | React 19, TypeScript, Tailwind CSS v4 |
| 3D | Three.js (STLLoader, OrbitControls) |
| Bundler | Vite 8 |
| WASM | OrcaSlicer v2.4.0 via Emscripten (own build) |
| Docs | Material for MkDocs |
| CI/CD | GitHub Actions → GitHub Pages |

## Licence

OrcaSlicer source is © 2022 SoftFever and contributors, AGPL-3.0.  
OrcaWeb UI, bridge, and build infrastructure are MIT.
