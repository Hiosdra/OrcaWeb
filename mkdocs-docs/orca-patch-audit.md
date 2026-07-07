# OrcaSlicer Patch Audit (2026-07-07)

This is an audit of every patch applied by `orca-wasm/patches/apply.py` against
a pristine checkout of `SoftFever/OrcaSlicer` at the version currently pinned
for WASM builds (`ORCA_VERSION` in `.github/workflows/build-wasm.yml`,
`v2.4.0` at the time of this audit). It records which patches are load-bearing
and which are candidates for removal. See [ADR-006](adr/adr-006-patch-strategy.md)
for the three-layer patch strategy this audit evaluates.

**Method:** shallow-cloned pristine `orca/` at the pinned tag, ran
`python3 orca-wasm/patches/apply.py --check`, and additionally tested every
individual regex from `apply.py` against the pristine tree in isolation
(a passing dry-run doesn't prove a *specific* substitution fired — `patch()`
only warns on a zero-match pattern, it doesn't fail). Cross-referenced
guarded CMake targets against the stub `Find*.cmake` modules in
`orca-wasm/cmake/`.

**Status:** items 1–4 were removed and validated in
[#92](https://github.com/Hiosdra/OrcaWeb/pull/92) (full `build-wasm.yml` CI
build + E2E smoke test, both green). Items 5–8 are still open.

## Summary

| # | Patch | Verdict | Reason |
|---|-------|---------|--------|
| 1 | Root: `find_package(wxWidgets)` guard | **Removed (#92)** | Pattern never matched; wxWidgets is found in `src/CMakeLists.txt` inside `if(SLIC3R_GUI)`, and WASM builds already force `SLIC3R_GUI=OFF` |
| 2 | Root: wrap `add_subdirectory(src)` | **Removed (#92)** | Replacement added `src` in both the WASM and non-WASM branches — identical to the unpatched original |
| 3 | `src/CMakeLists.txt`: guard GUI subdirs | **Removed (#92)** | Matched `add_subdirectory(slic3r)`, already inside the disabled `if(SLIC3R_GUI)` block |
| 4 | `libslic3r/CMakeLists.txt`: FreeType guard | **Removed (#92)** | Regex never matched (a comment line breaks it); harmless anyway since `FindFreetype.cmake` stubs `FREETYPE_LIBRARIES` to an empty INTERFACE target |
| 5 | `libslic3r/CMakeLists.txt`: `opencv_world` genexpr | **Open — likely redundant** | `FindOpenCV.cmake` already stubs `opencv_world` as an empty INTERFACE target; linking it unconditionally is a no-op. Verify with a test build before removing |
| 6 | `libslic3r/CMakeLists.txt`: draco guard + `draco::draco` genexpr | **Open — likely redundant** | Duplicates `Finddraco.cmake`. Currently the patch disables `find_package(draco)` under WASM, which makes the stub module dead code — pick one mechanism, not both |
| 7 | `Thumbnails.cpp`: `JCS_EXT_RGBA` define | **Open — unused & risky as fallback** | The only use site is inside the function body §6b fully replaces; as a "fallback" it would silently downgrade a compile error into a runtime libjpeg rejection |
| 8 | `FuzzySkin.cpp`: `static thread_local` variant | **Open — defensive, 0 matches** | v2.4.0 has only bare `thread_local` (3 occurrences); this is anti-"static static" insurance with no current target |

Items 1–4 changed no build output — CI confirmed OrcaSlicer v2.4.0 still
compiles and the WASM engine still passes its E2E smoke test with those
guards gone. Items 5–8 are believed equally safe by the same reasoning but
haven't been through a build yet.

## Confirmed load-bearing (do not touch)

Verified with a live regex match count against pristine v2.4.0 and/or a clear
runtime justification:

- `SLIC3R_WASM` option injection, `CMP0167` downgrade (Boost built with b2 has
  no `BoostConfig.cmake`)
- `libslic3r` compile-definitions injection (`SLIC3R_WASM`, `SLIC3R_NO_OPENVDB`,
  `SLIC3R_NO_OPENCV`)
- **TKSTEP → TKDESTEP** — v2.4.0 still lists the OCCT 7.7 toolkit names; the
  build links OCCT 7.8.1, which merged them into `TKDESTEP`
- fontconfig guard, `encoding_check()` guard (native binary, fails on the WASM
  runner)
- `GCode.hpp` narrowing fix (`size_t` on 32-bit WASM can't hold
  `numeric_limits<coord_t>::max()`)
- `AABBTreeLines.hpp` Eigen template deduction fix
- `Platform.cpp` — guard the unknown-platform `static_assert` (Emscripten
  isn't in OrcaSlicer's platform list)
- `Thumbnails.cpp` RGBA→RGB JPEG rewrite (Emscripten ships standard IJG
  libjpeg, not libjpeg-turbo; `JCS_EXT_RGBA` is invalid there)
- `utils.cpp` Boost.Log single-thread fixes (`unlocked_sink`, drop
  thread-ID attribute)
- `Thread.cpp` (§8g) — Emscripten no-op `set_thread_name()` branch, avoiding
  an `undefined symbol: pthread_setname_np` link failure under UBSan builds
- **All Arachne guards (§8, 8c, 8d, 8e, 8f)** — each fixes a UBSan-confirmed
  out-of-bounds/overflow reproducible on real meshes (Voron Design Cube,
  Stanford Bunny, a 1.1M-triangle model), not theoretical
- Both CMake injection blocks (§4c override sources, §9 bridge) and both
  header `copy_override()` calls (`ObjColorUtils.hpp`, `OpenVDBUtils.hpp`)

## Worth a closer look, but out of scope for a quick removal

- **`OpenVDB::openvdb` genexpr guard** — looks redundant against the stub
  `FindOpenVDB.cmake`, but removing it changes whether
  `if(TARGET OpenVDB::openvdb)` sees the stub target *before* the §4c
  `HEADER_FILE_ONLY` override runs, i.e. two mechanisms currently interact.
  Needs a build test, not just a regex check.
- **`overrides/.../Format/svg.cpp` stub** — its own comment says "OCCT not
  available", but OCCT is now compiled into the engine (see the note above
  §3b in `apply.py`). The real `svg.cpp` depends only on OCCT + bundled
  `nanosvg`; SVG import may work unstubbed today. Needs verification — this
  is a real behavior change (restoring SVG import), not just doc cleanup, so
  it's left as an open question rather than acted on here.

ADR-006's override table has been corrected to match current reality (it
previously listed `Format/STEP.cpp`/`.hpp` as stubbed, which stopped being
true once OCCT started compiling into the engine, and mischaracterized the
`FuzzySkin.cpp` in-place patch as a stub replacement).

## Recommended next step

Validate items 5–6 with a real WASM build (same process used for items 1–4
in #92) before removing them; items 7–8 are safe to drop without a build
since they're either unreachable or actively risky as written.
