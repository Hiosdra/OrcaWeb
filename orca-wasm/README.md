# orca-wasm — OrcaSlicer WASM build

Clean-room Emscripten build of [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) v2.3.2 targeting the browser.

## Directory structure

```
orca-wasm/
├── orca/                  ← git submodule: SoftFever/OrcaSlicer@v2.3.2
├── bridge/
│   ├── slicer.cpp         ← C++ bridge (orc_init / orc_slice / orc_free)
│   └── CMakeLists.txt
├── wasm/
│   ├── CMakeLists.txt     ← final Emscripten link target
│   ├── empty_main.cpp
│   └── shims/
│       ├── tbb/           ← sequential TBB stubs (no threading in WASM)
│       ├── oneapi/tbb/    ← oneAPI TBB redirects
│       └── openvdb/       ← minimal OpenVDB stubs
├── cmake/
│   ├── FindTBB.cmake      ← creates TBB::tbb from our shims
│   ├── FindOpenVDB.cmake  ← stub
│   ├── FindOpenCV.cmake   ← stub
│   └── Finddraco.cmake    ← stub
├── patches/
│   └── apply.py           ← Python patcher (regex-based, version-robust)
├── deps/
│   ├── build_boost.sh     ← builds Boost for WASM
│   └── build_math.sh      ← builds GMP, MPFR, CGAL for WASM
├── scripts/
│   └── build.sh           ← end-to-end build script
└── CMakeLists.txt         ← root cmake
```

## Local build

### Prerequisites

- Emscripten SDK (emsdk) — latest
- CMake 3.22+, Ninja
- Python 3.9+
- curl

### Steps

```bash
# 1. Clone OrcaSlicer submodule
git submodule update --init --depth 1 -- orca-wasm/orca
git -C orca-wasm/orca fetch --tags --depth 1 origin v2.3.2
git -C orca-wasm/orca checkout v2.3.2

# 2. Activate Emscripten
source /path/to/emsdk/emsdk_env.sh

# 3. Build (first run: ~30–60 min; subsequent: ~5 min with cache)
cd orca-wasm
./scripts/build.sh
```

Artifacts land in `../public/wasm/`:
- `slicer.js`   (~1.5 MB)
- `slicer.wasm` (~8 MB)
- `slicer.data` (~150 MB — OrcaSlicer profile bundle)

## C API

```c
// Initialise with a JSON config (all values string-encoded).
int orc_init(const char* json, int len);   // → 0 success

// Slice an STL file (raw binary bytes).
// *out_gcode is malloc'd — free with orc_free().
int orc_slice(const void* stl, int stl_len,
              char** out_gcode, int* out_len); // → 0 success

void        orc_free(void* ptr);
const char* orc_decode_exception(void*);  // → last error message
```

## Architecture

```
orca-wasm/
└── slicer.cpp (bridge)
    └── libslic3r (OrcaSlicer core, patched for WASM)
        ├── TBB shims   → sequential stubs, no threading
        ├── No OCCT     → STEP/SVG import disabled
        ├── No OpenVDB  → advanced mesh ops disabled
        └── No OpenCV   → calibration features disabled
```

## CI workflow

`.github/workflows/build-wasm.yml` — triggered manually or on a `v*.*.*` tag:
1. Installs Emscripten
2. Restores cached WASM deps (Boost, GMP, MPFR, CGAL)
3. Checks out OrcaSlicer at the requested tag
4. Applies patches
5. Builds
6. Uploads artifacts as a GitHub release (`wasm-v2.3.2`)

The main deploy workflow (`.github/workflows/deploy.yml`) downloads the compiled
WASM artifacts from GitHub releases of the *allanwrench* project for now, until
the custom v2.3.2 build has been validated.  Once the `build-wasm` workflow
succeeds for the first time, update `deploy.yml` to reference the `wasm-v2.3.2`
release on this repo instead.

## Licence

OrcaSlicer source is © 2022 SoftFever and contributors, AGPL-3.0.
The bridge code in `bridge/slicer.cpp` and build infrastructure in this directory
are the original work of the OrcaWeb project, MIT licence.
