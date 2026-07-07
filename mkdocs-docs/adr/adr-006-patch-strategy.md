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
immediately after `project()`. OpenCV, Draco, and OpenVDB link targets are
wrapped in `if(NOT SLIC3R_WASM)` guards or generator expressions.

wxWidgets, OpenGL, and FreeType/fontconfig are excluded a different way: they
only get `find_package`d inside OrcaSlicer's own `if(SLIC3R_GUI)` block, and
`orca-wasm/CMakeLists.txt` already forces `SLIC3R_GUI OFF` for WASM builds —
so `apply.py` doesn't need (and, since a 2026-07-07 audit, no longer carries)
its own guards for those. Likewise the `GUI/`, `slic3r/`, `OrcaSlicer/`, and
`bambu_studio/` subdirectories are excluded by the same `SLIC3R_GUI OFF`
switch, not by a WASM-specific guard on `add_subdirectory`. See
[the patch audit](../orca-patch-audit.md) for the full reasoning behind
removing those now-redundant guards.

Compile definitions `SLIC3R_WASM`, `SLIC3R_NO_OPENVDB`, `SLIC3R_NO_OPENCV` are
injected as `PUBLIC` into `libslic3r`'s `target_compile_definitions`, making
them available to all consumers. `SLIC3R_NO_OCCT` is deliberately *not*
injected — OCCT is compiled into the WASM engine (see Layer 2 below), so the
real OCCT-dependent code paths are used as-is.

### Layer 2 — C++ Override Stubs (`orca-wasm/overrides/`)

Source files that `#include` unavailable libraries (OpenVDB, OpenCV, Draco) are
excluded from the build and replaced with minimal stubs:

| Original | Replaced by stub because |
|----------|--------------------------|
| `Format/DRC.cpp` | Draco not available |
| `Format/svg.cpp` | Depends on OCCT (kept stubbed even though OCCT itself is now compiled in — see note below) |
| `OpenVDBUtils.cpp` + `.hpp` | OpenVDB not available |
| `ObjColorUtils.cpp` + `.hpp` | OpenCV not available |
| `SLA/Hollowing.cpp` | Depends on OpenVDB |
| `Shape/TextShape.cpp` | Depends on FreeType + OCCT |

`Format/STEP.cpp` + `.hpp` are **not** in this table — OCCT is compiled into
the WASM engine (see the "Build WASM deps — OCCT" step in
`.github/workflows/build-wasm.yml`), so the real STEP import/export code
compiles and runs as-is, unstubbed. `svg.cpp` depends only on OCCT + the
bundled `nanosvg` header, so it may also be restorable now — flagged as an
open question in [the patch audit](../orca-patch-audit.md) rather than acted
on yet, since nothing has verified it compiles/works unstubbed.

`Feature/FuzzySkin/FuzzySkin.cpp` is **not** a stub either, despite libnoise +
`thread_local` being the original blocker — libnoise is now WASM-compiled
(see Layer 1) and only the `thread_local` usage is patched in-place (see
"In-Place C++ Compatibility Fixes" below).

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
| `CMakeLists.txt` (libslic3r) | `TKXDESTEP TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase` → `TKDESTEP` (OCCT 7.8 consolidated these STEP toolkits; the older names fail to link against our OCCT 7.8.1) |
| `GCode.hpp` | `size_t` narrowing from `INT64_MAX` → `static_cast<size_t>(-1)` (32-bit WASM) |
| `AABBTreeLines.hpp` | Explicit template cast (`decltype(nearest_point)(origin.template cast<…>())`) for Eigen deduction |
| `Feature/FuzzySkin/FuzzySkin.cpp` | `thread_local` → `static` (single-threaded WASM build) |
| `Platform.cpp` | Guard unknown-platform `static_assert` with `#ifndef SLIC3R_WASM` |
| `GCode/Thumbnails.cpp` | Replace `JCS_EXT_RGBA` (libjpeg-turbo extension) with RGBA→RGB conversion for standard IJG libjpeg |
| `utils.cpp` | `synchronous_sink` → `unlocked_sink`; remove thread-ID log expression (Boost.Log ST mode) |
| `Thread.cpp` | Give Emscripten its own no-op `set_thread_name()` branch instead of calling `pthread_setname_np()`, which this single-threaded build doesn't provide |
| `Arachne/SkeletalTrapezoidation.cpp`, `Arachne/WallToolPaths.cpp`, `Arachne/WallToolPaths.hpp` | Five guards against UBSan-confirmed out-of-bounds reads/writes and integer overflow in degenerate-geometry cases (empty shapes, junction-less lines, uninitialized params) — reproducible on real meshes (Voron Design Cube, Stanford Bunny), not theoretical |

Removed patches are documented inline in `apply.py` where they were deleted
(search for `NOTE:`) rather than here, to avoid this table drifting further
out of sync — e.g. a former `Model.cpp` guard around `read_from_step()` was
removed once OCCT started compiling in cleanly. See
[the patch audit](../orca-patch-audit.md) for a full audit of which current
patches are still load-bearing.

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
