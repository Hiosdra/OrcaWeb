# OrcaWeb — Browser Slicer

OrcaSlicer compiled to WebAssembly. Slice STL files directly in the browser — no server, no upload, 100% private.

**[Live app, multithreaded engine →](https://orcaweb-cf-pages.themppsplx.workers.dev/)**  |  **[Compatibility app (ST) →](https://hiosdra.github.io/OrcaWeb/app/)**  |  **[Documentation →](https://hiosdra.github.io/OrcaWeb/docs/)**

The Cloudflare mirror is the primary cross-origin-isolated product deployment,
so it runs the real multithreaded (MT) WASM engine. GitHub Pages remains the
single-threaded (ST) compatibility deployment because it cannot send the
headers required by `SharedArrayBuffer` — see below.

## Features

- Full OrcaSlicer engine (WASM) — same slicing quality as the desktop app
- 3D model preview + G-code layer visualiser side-by-side
- Import STL, 3MF, OBJ, and STEP files — OBJ and STEP are converted to STL by native OrcaSlicer/OCCT code compiled into the WASM engine, no extra downloads
- Import one or more OrcaSlicer profiles (.json), including a machine/process
  set with one filament profile per material slot
- Built-in presets: Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4

## Quick start (local dev)

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
npm install
node scripts/download-wasm.mjs   # ~38 MB ST fallback for local dev
npm run dev
```

The download script fetches pre-built WASM artifacts into `public/wasm/`.
Those files are gitignored (too large for git).

## Architecture

A React UI (main thread) hands STL/3MF/OBJ/STEP files to a Web Worker running
the OrcaSlicer engine compiled to WebAssembly. The worker selects the primary
MT pair (`slicer-mt.js` + `slicer-mt.wasm`) on a cross-origin-isolated host and
falls back to the ST pair (`slicer.js` + `slicer.wasm`) when the host or assets
do not support threads. There is no
`slicer.data` — the headless flat-config slicer never reads `orca/resources`
at runtime, so the 200 MB preload file used by older builds was eliminated
entirely.

→ Full diagram and component breakdown: [`mkdocs-docs/architecture.md`](mkdocs-docs/architecture.md)

### WASM loading

In CI the WASM artifacts are downloaded from the highest immutable release in
the `wasm-v2.4.2` / `wasm-v2.4.2-patchN` family and embedded directly in the
GitHub Pages deployment, so they are served from the **same origin** as the app
— no CORS issues.

The Cloudflare Workers mirror deploy cannot host the engine itself — both
`slicer.wasm` (~38 MB) and the multithreaded `slicer-mt.wasm` (~37 MB, see
below) exceed Cloudflare's 25 MiB per-asset limit — so its build
(`npm run build:cf`, see `scripts/cf-build.mjs`) points `VITE_WASM_BASE_URL`
at the GitHub Pages copy, which is served with `Access-Control-Allow-Origin: *`.

### Single-threaded vs multithreaded engine

The engine ships as two builds: a **multithreaded (MT)** variant
(`slicer-mt.js`/`slicer-mt.wasm`, real oneTBB linked against Emscripten
pthreads) and a **single-threaded (ST)** compatibility variant
(`slicer.js`/`slicer.wasm`). MT is the primary product path on the
[cross-origin-isolated Cloudflare mirror](https://orcaweb-cf-pages.themppsplx.workers.dev/);
GitHub Pages and other ordinary hosts use ST because they cannot send the
required `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers.
The worker probes for MT at runtime and falls back to ST on any failure. See
[ADR-011](mkdocs-docs/adr/adr-011-multithreaded-engine.md) and [the ST vs MT
benchmark](mkdocs-docs/st-mt-benchmark.md).

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
immutable `wasm-v2.4.2` or `wasm-v2.4.2-patchN` release with the compiled artifacts —
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
