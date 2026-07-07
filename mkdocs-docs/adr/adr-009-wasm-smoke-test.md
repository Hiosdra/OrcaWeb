# ADR-009: WASM Build Smoke Test

**Status:** Accepted  
**Date:** 2026-07-04

## Context

`build-wasm.yml` compiles OrcaSlicer, links it into `slicer.wasm`, and — until
this change — went straight from a successful compile to packaging and
publishing a GitHub Release. Compiling cleanly is not the same as working: this
project has twice shipped an engine that compiled fine but trapped on a real
slice —

- The Voron Design Cube v7 STL triggered a "memory access out of bounds" trap
  in Arachne's wall generator (uninitialized `WallToolPathsParams` fields —
  see `orca-wasm/patches/apply.py` sections 8/8c–8f and the `--profiling-funcs`
  comment in `orca-wasm/wasm/CMakeLists.txt`, which references a
  `scripts/repro-real-stl.mjs` reproduction script that was used locally but
  never committed to the repo).
- `Print::get_hrc_by_nozzle_type()`'s `BOOST_LOG_TRIVIAL(error)` call trapped on
  *every* slice until `ensure_nozzle_info_json()` was added (see
  `orca-wasm/bridge/slicer.cpp`).

Neither of these would have been caught by `emmake cmake --build` succeeding.
They were only found by someone manually slicing a real file against a real
deployed build.

## Decision

Add `orca-wasm/scripts/smoke-test.mjs`: a plain Node script (no TS build step,
matching `scripts/download-wasm.mjs`'s style) that loads the just-built
`slicer.js` + `slicer.wasm` and runs real `orc_init`/`orc_slice`/`orc_slice_multi`
calls end-to-end:

1. **default** — a representative config (Generic 0.4mm nozzle, PLA, 0.2mm
   layers), run against **two meshes**: a synthetic torture-test mesh (a
   subdivided icosphere, ~5120 triangles — generated in-memory, no
   redistribution question, runs fully offline) and the real Voron Design
   Cube v7 (`e2e/fixtures/voron-design-cube-v7.stl`, vendored under GPL-3.0 —
   see ADR-010 for why that's safe alongside this repo's AGPL-3.0-or-later).
   The real mesh is not optional window-dressing: it's the exact model that
   found both crashes in this ADR's own Context section, and later a
   Boost.Log-amplified hang/trap that the synthetic mesh never triggered (see
   the "disable Boost.Log core" fix in `orca-wasm/bridge/slicer.cpp`) —
   synthetic-only coverage would have shipped that regression again.
   `--fixture <path>` replaces both meshes with one specific file, for a
   closer repro of a particular case.
2. **fuzzy skin = all** — exercises the libnoise-backed FuzzySkin path (ADR
   context: `mkdocs-docs/architecture.md`'s "libnoise" section).
3. **classic wall generator** — a regression control against the Arachne
   default, so a future Arachne-specific regression doesn't take down the
   classic path's coverage with it.
4. **plate, 2 objects, per-object `extruder` override** — probes the
   `extruder_ids` plumbing added in ADR-008 (single-nozzle multi-material
   assignment only; deliberately does **not** exercise a real multi-nozzle
   `nozzle_diameter` array, which remains a known, unverified crash risk — see
   `status.md`'s "Multi-ekstruder / multi-material" section).

Scenarios 2–4 also run against both meshes, not just the synthetic one — every
scenario × mesh combination is exercised (8 total by default).

Each scenario asserts the return code is `0` and the resulting G-code is
non-trivially sized and contains real `G1` extrusion moves — not just "didn't
crash" but "produced something that looks like a slice." On failure, the
script prints the engine's own `orc_decode_exception()` message, not just a
generic Node stack trace, and exits non-zero.

Wired into `build-wasm.yml` as a step between "Package WASM artifacts" and
"Upload artifacts"/the GitHub Release step, so a broken build never reaches
either. Also appended to `orca-wasm/scripts/build-local-wsl.sh` (regenerated
via `scripts/gen-wsl-build-script.mjs` — that file is generated, not
hand-edited) and exposed as `npm run smoke-test` for ad-hoc use, e.g. after
`npm run setup` downloads a pre-built engine.

## Consequences

- **Positive:** A build that compiles but traps (or silently produces garbage)
  is caught in CI, before anyone downloads it.
- **Positive:** Directly exercises the ADR-008 session-handle refactor and the
  new `extruder_ids` parameter — the first real compiler+runtime check either
  gets, since this sandbox has no Emscripten toolchain to build against
  locally.
- **Negative / accepted scope:** Verifies "doesn't crash and looks like a real
  slice," not slice *quality* (wall placement, timing, exact G-code content).
  A golden-file G-code comparison would catch quality regressions too, but
  needs regenerating on every legitimate engine/profile change — deferred
  until the crash-class of regression (the one that has actually bitten this
  project twice) is reliably covered.
- **Negative:** Adds Node + a few seconds of slicing to `build-wasm.yml`,
  negligible next to the ~1–3 hour dependency build. Running every scenario
  against both meshes roughly doubles this step's time — still seconds, not
  a meaningful cost.
