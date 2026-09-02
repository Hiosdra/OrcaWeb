# Getting Started

## Prerequisites

- **Node.js 22 LTS** — [nodejs.org](https://nodejs.org) (the version used by CI; Node 24 currently leaves Playwright's local Vite server running after E2E tests on Windows)
- ~**40 MB** free disk space for the current ST WASM artifacts

## Installation

### 1. Clone

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
```

### 2. Install dependencies

```bash
npm install
```

### 3. Download WASM artifacts

The OrcaSlicer WASM files are not stored in the repository (served from a tagged GitHub Release to keep clone size small). Download them once with:

```bash
node scripts/download-wasm.mjs
```

This fetches two files into `public/wasm/`:

| File | Size | Description |
|------|------|-------------|
| `slicer.js` | ~220 KB | Emscripten glue code |
| `slicer.wasm` | ~38 MB | Compiled OrcaSlicer v2.4.2 + OCCT (STEP engine) |

The downloader resolves the highest immutable ST fallback release in the
pinned OrcaSlicer version's base/patch family. The current ST fallback is
[`wasm-v2.4.2-patch12`](https://github.com/Hiosdra/OrcaWeb/releases/tag/wasm-v2.4.2-patch12).
The primary product deployment uses the MT pair from
[`wasm-v2.4.2-patch13-multithreaded`](https://github.com/Hiosdra/OrcaWeb/releases/tag/wasm-v2.4.2-patch13-multithreaded)
when cross-origin isolation is available. For manual client migration,
including cache invalidation and MT-first fallback selection, see [WASM Engine
Migration](wasm-engine-migration.md).

### 4. Start dev server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## First slice

1. **Model tab** — drag & drop an STL file or click to browse
2. **Settings tab** — choose printer, filament, quality preset; optionally import one or more OrcaSlicer `.json` profiles
3. **Slice tab** — click **Slice model**; wait ~50–500 ms depending on model complexity
4. When complete, a **Download G-code** button appears next to a live G-code preview

## Importing OrcaSlicer profiles

In the **Settings tab**, click **Import profiles (.json)**. You can select one
machine/process/print JSON and one filament JSON per material slot in the same
file-picker action. The import is validated and applied atomically.

Profile files are typically found at:

=== "Windows"
    ```
    %APPDATA%\OrcaSlicer\user\default\
    ```
=== "macOS"
    ```
    ~/Library/Application Support/OrcaSlicer/user/default/
    ```
=== "Linux"
    ```
    ~/.config/OrcaSlicer/user/default/
    ```

The folder contains three subdirectories: `machine/`, `filament/`, and `process/`. Any `.json` file from these directories can be imported. For a
dual-nozzle setup, select both filament files together; OrcaWeb keeps known
material slots deterministic and maps them to the imported nozzle vector.

For the Voron backup used by the production walkthrough, select:

```text
orcaslicer/user/1945486786/machine/Voron 0.4.json
orcaslicer/user/1945486786/process/0.20mm Tuned.json
orcaslicer/user/1945486786/filament/Voron PLA.json
orcaslicer/user/1945486786/filament/Voron PETG.json
```

The app only reads files selected locally. It does not authenticate to GitHub
or download profiles from a private repository.

→ [Profile format reference](profiles.md)
