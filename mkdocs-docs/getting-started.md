# Getting Started

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- ~**20 MB** free disk space for WASM artifacts

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
| `slicer.js` | ~1.5 MB | Emscripten glue code |
| `slicer.wasm` | ~16 MB | Compiled OrcaSlicer v2.3.2 + OCCT (STEP/IGES engine) |

Source: OrcaWeb GitHub Release [`wasm-v2.3.2`](https://github.com/Hiosdra/OrcaWeb/releases/tag/wasm-v2.3.2) (self-built via `orca-wasm/` pipeline).

### 4. Start dev server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## First slice

1. **Model tab** — drag & drop an STL file or click to browse
2. **Settings tab** — choose printer, filament, quality preset; optionally import an OrcaSlicer `.json` profile
3. **Slice tab** — click **Slice model**; wait ~50–500 ms depending on model complexity
4. When complete, a **Download G-code** button appears next to a live G-code preview

## Importing OrcaSlicer profiles

In the **Settings tab**, click **Import OrcaSlicer profile (.json)** and select any profile JSON from your desktop OrcaSlicer installation.

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

The folder contains three subdirectories: `machine/`, `filament/`, and `process/`. Any `.json` file from these directories can be imported.

→ [Profile format reference](profiles.md)
