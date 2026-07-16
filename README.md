# OrcaWeb — Browser Slicer

OrcaSlicer compiled to WebAssembly. Slice STL files directly in the browser — no server, no upload, 100% private.

**[Live app →](https://hiosdra.github.io/OrcaWeb/app/)**  |  **[Documentation →](https://hiosdra.github.io/OrcaWeb/docs/)**

## Features

- Full OrcaSlicer engine (WASM) — same slicing quality as the desktop app
- 3D model preview + G-code layer visualiser side-by-side
- Import STL, 3MF, OBJ, and STEP files — OBJ and STEP are converted to STL by native OrcaSlicer/OCCT code compiled into the WASM engine, no extra downloads
- Import OrcaSlicer profiles (.json) from your desktop installation
- Built-in presets: Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4

## Quick start (local dev)

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
npm install
node scripts/download-wasm.mjs   # ~29 MB, one-time download
npm run dev
```

The download script fetches pre-built WASM artifacts into `public/wasm/`.
Those files are gitignored (too large for git).

## Architecture

A React UI (main thread) hands STL/3MF/OBJ/STEP files to a Web Worker running
the OrcaSlicer engine compiled to WebAssembly (`slicer.js` + `slicer.wasm`,
~29 MB, includes OCCT for STEP import) and gets G-code back. There is no
`slicer.data` — the headless flat-config slicer never reads `orca/resources`
at runtime, so the 200 MB preload file used by older builds was eliminated
entirely.

→ Full diagram and component breakdown: [`mkdocs-docs/architecture.md`](mkdocs-docs/architecture.md)

### WASM loading

In CI the WASM artifacts are downloaded from the latest immutable
`wasm-v2.4.2` (optionally `-patchN`) GitHub Release and embedded directly in
the GitHub Pages deployment, so they are served from the **same origin** as the app —
no CORS issues.

The Cloudflare Workers mirror deploy cannot host the engine itself — both
`slicer.wasm` (~29 MB) and the multithreaded `slicer-mt.wasm` (~36 MB, see
below) exceed Cloudflare's 25 MiB per-asset limit — so its build
(`npm run build:cf`, see `scripts/cf-build.mjs`) points `VITE_WASM_BASE_URL`
at the GitHub Pages copy, which is served with `Access-Control-Allow-Origin: *`.

### Single-threaded vs multithreaded engine

The engine ships as two builds: a **single-threaded (ST)** variant
(`slicer.js`/`slicer.wasm`) served everywhere, and a **multithreaded (MT)**
variant (`slicer-mt.js`/`slicer-mt.wasm`, real oneTBB linked against
Emscripten pthreads) served only where the page is cross-origin isolated —
today, only the Cloudflare mirror. GitHub Pages cannot send the required
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, so it
always serves ST. The worker probes for the MT engine at runtime and falls
back to ST on any failure. See [ADR-011](mkdocs-docs/adr/adr-011-multithreaded-engine.md)
and [the ST vs MT benchmark](mkdocs-docs/st-mt-benchmark.md).

### Self-contained WASM build (v2.4.2)

`orca-wasm/` contains a clean-room Emscripten build pipeline targeting
OrcaSlicer **v2.4.2** (the latest stable release as of this writing), producing
both the ST and MT engine variants described above.

Build the WASM module locally (Linux / macOS / WSL2 — see
[`mkdocs-docs/wasm-build.md`](mkdocs-docs/wasm-build.md) for full setup):
```bash
# from the repo root, not orca-wasm/
./orca-wasm/scripts/build-local-wsl.sh
```

Or trigger the `Build WASM` GitHub Actions workflow manually to publish a new
`wasm-v2.4.2` (optionally `-patchN`) release with the compiled artifacts —
releases are immutable, so a rebuild never overwrites a previous one (see
[`mkdocs-docs/wasm-build.md`](mkdocs-docs/wasm-build.md)).

See [`orca-wasm/README.md`](orca-wasm/README.md) for the directory layout, full
C API, and build guide.

## Stack

| | |
|---|---|
| UI | React 19, TypeScript, Tailwind CSS v4 |
| 3D | Three.js (STLLoader, OrbitControls) |
| Bundler | Vite 8 |
| WASM | OrcaSlicer v2.4.2 via Emscripten (own build) |
| Docs | Material for MkDocs |
| CI/CD | GitHub Actions → GitHub Pages (primary), Cloudflare Workers (mirror) |

## Licence

OrcaSlicer source is © 2022 SoftFever and contributors, AGPL-3.0.  
OrcaWeb UI, bridge, and build infrastructure are AGPL-3.0-or-later
(see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md)).
