# OrcaWeb

**OrcaSlicer v2.4.2 running entirely in your browser via WebAssembly.**

Slice STL files locally — no server, no account, no upload. Your files never leave your device.

<div class="grid cards" markdown>

- :lock: **100% Private**

    Your STL files are processed locally. No data is ever sent to any server.

- :zap: **OrcaSlicer Engine**

    Same slicing quality as the OrcaSlicer desktop app, compiled to WebAssembly via Emscripten.

- :material-layers: **G-code Visualiser**

    Layer-by-layer toolpath preview. Scroll through layers with a slider. Model and G-code rendered in the same coordinate system.

- :package: **Profile Import**

    Import machine, filament, or process profiles directly from your OrcaSlicer desktop installation.

</div>

## Quick start

Clone, install, download the WASM engine, and run the dev server — see the
[full setup guide](getting-started.md) for the commands and prerequisites.

## Try it online

The slicer is deployed at **[hiosdra.github.io/OrcaWeb/app/](https://hiosdra.github.io/OrcaWeb/app/)**.

On first load, the browser downloads ~29 MB of WASM data from GitHub Releases. Subsequent visits use the browser cache (or the PWA service worker pre-cache).

## How it works

A React UI on the main thread hands STL/3MF/OBJ/STEP files to a Web Worker
running the OrcaSlicer engine compiled to WebAssembly, and gets G-code back.

→ [Full architecture docs](architecture.md)
