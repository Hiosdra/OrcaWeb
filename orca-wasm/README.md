# orca-wasm — OrcaSlicer WASM build

Clean-room Emscripten build of [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) v2.4.0 targeting the browser.

→ **[Full build guide in the docs](https://hiosdra.github.io/OrcaWeb/docs/wasm-build/)**

## Directory structure

```
orca-wasm/
├── orca/                  ← git submodule: SoftFever/OrcaSlicer@v2.4.0
├── bridge/
│   ├── slicer.cpp         ← C++ bridge (orc_init / orc_slice / orc_obj_to_stl)
│   └── CMakeLists.txt
├── wasm/
│   ├── CMakeLists.txt     ← final Emscripten link target
│   ├── empty_main.cpp
│   └── shims/
│       ├── tbb/           ← sequential TBB stubs (no threading in WASM)
│       ├── oneapi/tbb/    ← oneAPI TBB redirects
│       ├── openvdb/       ← minimal OpenVDB type stubs
│       ├── freetype/      ← minimal FreeType type stubs
│       └── openssl/       ← minimal OpenSSL/MD5 stub
├── overrides/             ← no-op C++ stubs replacing OCCT/OpenVDB/OpenCV/Draco
│   └── src/libslic3r/
│       ├── Format/STEP.{hpp,cpp}
│       ├── Format/DRC.cpp
│       ├── Format/svg.cpp
│       ├── OpenVDBUtils.{hpp,cpp}
│       ├── ObjColorUtils.{hpp,cpp}
│       ├── SLA/Hollowing.cpp
│       └── Shape/TextShape.cpp
├── cmake/
│   ├── FindTBB.cmake      ← creates TBB::tbb from our shims
│   ├── FindOpenVDB.cmake  ← stub
│   ├── FindOpenCV.cmake   ← stub
│   └── Finddraco.cmake    ← stub
├── patches/
│   └── apply.py           ← idempotent Python patcher (regex-based)
├── scripts/
│   └── build-local-wsl.sh ← end-to-end local build script (generated from
│                             .github/workflows/build-wasm.yml — see
│                             ../scripts/gen-wsl-build-script.mjs)
└── CMakeLists.txt         ← root cmake
```

## Artifacts

| File | Size | Description |
|------|------|-------------|
| `slicer.wasm` | ~33 MB | Compiled OrcaSlicer v2.4.0 core + OCCT (STEP engine) |
| `slicer.js` | ~220 KB | Emscripten glue code (CommonJS IIFE) |

No `slicer.data` — the headless flat-config slicer never reads `orca/resources` at runtime, so the 200 MB preload file was eliminated entirely.

## Local build

Full setup instructions (Linux / macOS / WSL2, including package-manager
commands): **[mkdocs-docs/wasm-build.md](../mkdocs-docs/wasm-build.md)**.

Short version, once emsdk 3.1.74 and the system build tools (cmake, ninja,
python3, m4, texinfo, openssl, ccache, a C/C++ toolchain) are installed:

```bash
# from the repo root, not orca-wasm/
./orca-wasm/scripts/build-local-wsl.sh
```

Cold (deps + compile): ~2.5–3 h, mostly OCCT (~45–60 min). Warm (only C++
changed, deps + ccache already populated): ~10–15 min. Artifacts land
directly in `../public/wasm/` (`slicer.js` + `slicer.wasm`).

`build-local-wsl.sh` is generated from `.github/workflows/build-wasm.yml`
via `../scripts/gen-wsl-build-script.mjs`, so it can't silently drift from
what CI actually runs — re-run the generator after editing the workflow
instead of hand-editing the script.

## C API

Exported by `slicer.wasm` via Emscripten. Called as `_orc_*` from JavaScript.

```c
// Initialise with a JSON config (all values string-encoded as in OrcaSlicer).
int _orc_init(const char* json, int len);   // → 0 success

// Slice an STL file (raw binary bytes).
// *out_gcode is heap-allocated — free with _orc_free().
int _orc_slice(const void* stl, int stl_len,
               char** out_gcode, int* out_len); // → 0 success

// Convert an OBJ file to binary STL (no _orc_init required).
int _orc_obj_to_stl(const char* obj, int obj_len,
                    char** out_stl, int* out_len); // → 0 success

void        _orc_free(void* ptr);
const char* _orc_decode_exception(void*);  // → last error C string
```

## Architecture

```
orca-wasm/
└── slicer.cpp (bridge)
    └── libslic3r (OrcaSlicer core, patched for WASM)
        ├── TBB shims     → sequential stubs, no threading
        ├── No OCCT       → STEP/SVG/TextShape disabled (overrides)
        ├── No OpenVDB    → hollowing disabled (overrides)
        ├── No OpenCV     → OBJ colour calibration disabled (overrides)
        ├── No Draco      → Draco mesh import disabled (overrides)
        └── libnoise      → compiled for WASM; FuzzySkin patched in-place
```

See the [Architecture docs](https://hiosdra.github.io/OrcaWeb/docs/architecture/#engine-clean-layer-override-approach) for the full table of stubs.

## CI workflow

`.github/workflows/build-wasm.yml` — triggered by:
- **Manual dispatch:** Actions → Build WASM → Run workflow (specify OrcaSlicer tag)
- **Tag push:** `git tag wasm-v2.4.0-ow1 && git push --tags`

Steps:
1. Installs Emscripten 3.1.74
2. Restores cached WASM deps (Boost, GMP, MPFR, CGAL)
3. Checks out OrcaSlicer at the requested tag
4. Runs `patches/apply.py`
5. Builds with `cmake + ninja`
6. Publishes `slicer.js` + `slicer.wasm` to a new, immutable GitHub Release:
   `wasm-$ORCA_VERSION` for the first build of a given OrcaSlicer version,
   `wasm-$ORCA_VERSION-patchN` for every later fix to `orca-wasm/` targeting
   the same OrcaSlicer version — a rebuild never overwrites a previous
   release's assets.

The main deploy workflow (`.github/workflows/deploy.yml`) resolves the
highest-numbered release for the pinned OrcaSlicer version at deploy time,
downloads its artifacts, and embeds them in the GitHub Pages deployment
under `app/wasm/`, served from the same origin as the app.

## Licence

OrcaSlicer source is © 2022 SoftFever and contributors, AGPL-3.0.
The bridge code in `bridge/slicer.cpp` and build infrastructure in this directory
are the original work of the OrcaWeb project, MIT licence.
