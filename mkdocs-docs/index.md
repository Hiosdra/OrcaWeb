# OrcaWeb

**OrcaSlicer v2.3.2 running entirely in your browser via WebAssembly.**

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

```bash
git clone https://github.com/Hiosdra/OrcaWeb.git
cd OrcaWeb
npm install
node scripts/download-wasm.mjs   # ~9 MB, one-time
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

→ [Full setup guide](getting-started.md)

## Try it online

The slicer is deployed at **[hiosdra.github.io/OrcaWeb/app/](https://hiosdra.github.io/OrcaWeb/app/)**.

On first load, the browser downloads ~9 MB of WASM data from GitHub Releases. Subsequent visits use the browser cache (or the PWA service worker pre-cache).

## How it works

```
Browser
├── React UI  (main thread)
│   ├── ModelViewer   → Three.js, STL on print bed
│   ├── GcodeViewer   → toolpaths, layer slider
│   └── SettingsPanel → presets + profile import
│
└── Web Worker
    └── OrcaSlicer v2.3.2 core (WebAssembly)
        ├── slicer.js    ~1.5 MB  Emscripten glue
        └── slicer.wasm  ~7.5 MB  compiled slicer
```

No `slicer.data` — the headless slicer never reads `orca/resources` at runtime.

→ [Full architecture docs](architecture.md)
