# ADR-006: Three-Layer Engine Patch Strategy

**Status:** Accepted  
**Date:** 2026-06-14

## Context

OrcaSlicer has no official WebAssembly build target. Its CMake tree assumes a
desktop environment with native dependencies: wxWidgets, OpenGL, OCCT
(OpenCASCADE), OpenCV, OpenVDB, Draco, FreeType, fontconfig, libnoise, and a
multithreaded TBB runtime. None of these are available in an Emscripten/WASM
environment.

We needed a repeatable, maintainable strategy for adapting OrcaSlicer's source to
compile under Emscripten without modifying the submodule source in-place (which
would prevent clean `git pull` upgrades).

**Constraint:** We must not fork or permanently modify the `orca/` submodule.
The patch mechanism must be idempotent (safe to re-run) and easy to extend.

## Decision

Apply patches through three independent layers, each addressing a different class
of problem:

### Layer 1 — CMake Guards (`SLIC3R_WASM` option)

`apply.py` injects a `SLIC3R_WASM OFF` CMake option into `orca/CMakeLists.txt`
immediately after `project()`. Every heavy GUI dependency (wxWidgets, OpenGL,
OCCT, OpenCV, Draco, noise, fontconfig, FreeType) is wrapped in
`if(NOT SLIC3R_WASM)` guards or generator expressions. The `GUI/`, `slic3r/`,
`OrcaSlicer/`, and `bambu_studio/` subdirectories are excluded entirely.

Compile definitions `SLIC3R_WASM`, `SLIC3R_NO_OCCT`, `SLIC3R_NO_OPENVDB`,
`SLIC3R_NO_OPENCV` are injected as `PUBLIC` into `libslic3r`'s
`target_compile_definitions`, making them available to all consumers.

### Layer 2 — C++ Override Stubs (`orca-wasm/overrides/`)

Source files that `#include` unavailable libraries (OCCT, OpenVDB, OpenCV,
FreeType) are excluded from the build and replaced with minimal stubs:

| Original | Replaced by stub because |
|----------|--------------------------|
| `Format/STEP.cpp` + `.hpp` | OCCT not available |
| `Format/DRC.cpp` | Draco not available |
| `Format/svg.cpp` | Depends on OCCT |
| `OpenVDBUtils.cpp` + `.hpp` | OpenVDB not available |
| `ObjColorUtils.cpp` + `.hpp` | OpenCV not available |
| `SLA/Hollowing.cpp` | Depends on OpenVDB |
| `Shape/TextShape.cpp` | Depends on FreeType + OCCT |
| `Feature/FuzzySkin/FuzzySkin.cpp` | libnoise + `thread_local` unavailable |

Header overrides (`.hpp`) are **physically copied** into the `orca/` source tree
by `apply.py`. This is necessary because the C++ compiler searches the file's
own directory before any `-I` include paths — a `-I` override would not take
precedence.

### Layer 3 — Header Shims (`orca-wasm/wasm/shims/`)

`target_include_directories(orca_web_bridge BEFORE PUBLIC ...)` makes
`orca-wasm/wasm/shims/` the highest-priority include path. Shim headers provide
minimal type stubs so the compiler finds the right declarations without actually
linking any library:

- **TBB** — full sequential shim (see ADR-007)
- **OpenVDB** — `openvdb/openvdb.h` with minimal types (`Index32`, `Index64`,
  `math::Transform`, `initialize()`)
- **FreeType** — `ft2build.h` + `freetype/*.h` with types needed by `TextShape.hpp`
- **OpenSSL MD5** — `openssl/md5.h` stub (MD5 unused in FDM slice path)

### Patch Script (`orca-wasm/patches/apply.py`)

- Idempotent: repeated runs are safe (each patch checks for its own guard before
  applying).
- Supports three patch modes: regex substitution, header copy, brace-counting
  block replacement (for wrapping multi-line C++ function bodies).
- Dry-run: `python3 patches/apply.py --check` validates without modifying files.

## In-Place C++ Compatibility Fixes

A small set of actual source fixes are applied by `apply.py` (these would be
suitable upstream PRs):

| File | Fix |
|------|-----|
| `GCode.hpp` | `size_t` narrowing from `INT64_MAX` → `static_cast<size_t>(-1)` (32-bit WASM) |
| `Model.cpp` | Guard `read_from_step()` body with `#ifndef SLIC3R_NO_OCCT` to avoid duplicate symbol |
| `AABBTreeLines.hpp` | Explicit template cast (`decltype(nearest_point)(origin.template cast<…>())`) for Eigen deduction |
| `Platform.cpp` | Guard unknown-platform `static_assert` with `#ifndef SLIC3R_WASM` |
| `GCode/Thumbnails.cpp` | Replace `JCS_EXT_RGBA` (libjpeg-turbo extension) with RGBA→RGB conversion for standard IJG libjpeg |
| `utils.cpp` | `synchronous_sink` → `unlocked_sink`; remove thread-ID log expression (Boost.Log ST mode) |

## Adding a New Patch

1. **C++ compatibility fix** → add regex tuple to `patch()` in `apply.py`.
2. **Stub `.cpp`** → create `orca-wasm/overrides/src/libslic3r/<path>.cpp`,
   add original to `_wasm_orig_stubs`, add stub to `target_sources` in `apply.py`.
3. **Stub `.hpp`** → create `orca-wasm/overrides/src/libslic3r/<path>.hpp`,
   add `copy_override(...)` call in `apply.py`.
4. **New shim header** → add file to `orca-wasm/wasm/shims/`; it is picked up
   automatically via the `BEFORE PUBLIC` include path.

After any change: `python3 orca-wasm/patches/apply.py --check`.

## Consequences

- **Positive:** `orca/` submodule stays clean — `git pull` + re-run `apply.py` is
  the upgrade path.
- **Positive:** Clear separation of concerns — each layer handles a distinct class
  of incompatibility.
- **Positive:** Idempotent script means CI can always re-apply patches on a fresh
  checkout.
- **Negative:** Maintaining the patch set requires understanding of both CMake and
  Emscripten internals.
- **Negative:** Physical header copies in Layer 2 mean `apply.py` must track which
  files have been overridden to detect drift.
