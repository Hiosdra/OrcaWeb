# ADR-005: Headless Flat-Config — Eliminating slicer.data

**Status:** Accepted  
**Date:** 2026-06-13

## Context

The external WASM artifact (used before ADR-004) shipped a `slicer.data` file
containing all OrcaSlicer runtime resources: preset JSON files, fonts, translation
tables — packed by Emscripten's `--preload-file` into a single 144–200 MB blob
loaded into MEMFS at startup.

This created serious problems:

- **200 MB download** per user on first visit (before any caching).
- **GitHub's 100 MB file size limit** forced splitting into multiple `.part0`,
  `.part1`, … files and reassembling them in the worker.
- **Git LFS** required for release artifacts, adding operational complexity.
- **Slow module startup** — MEMFS population blocks the WASM instantiation path.

The key question was: **does a headless FDM slicer actually need those resources?**

## Investigation

We hooked `FS.open` inside the running WASM module and performed a full slice of
a 20 mm test cube. Result:

- **Only 4 files opened:** `/tmp/ow_in.stl`, `/tmp/ow_out.gcode`,
  `/tmp/ow_out.gcode.tmp`, `/tmp/ow_out.gcode.postprocess`.
- **Zero reads from `/resources`.**

We then stripped all 12,876 files from the MEMFS `/resources` tree and re-ran
the slice. Output was **byte-for-byte identical** (174,799 bytes).

**Why:** OrcaWeb's bridge (`slicer.cpp`) never calls `set_resources_dir()` or
instantiates `PresetBundle`. Configuration is built entirely in JavaScript
(`src/lib/profiles.ts`) and passed as a flat JSON string to `_orc_init`. 3MF
reading/writing (`orc_read_3mf`/`orc_write_3mf`, issue #108) go through
`libslic3r/Format/bbs_3mf.hpp` directly and likewise never touch
`/resources`.

## Decision

Remove `--preload-file` from `orca-wasm/wasm/CMakeLists.txt` and add
`-sFORCE_FILESYSTEM=1` (keeps MEMFS available for `/tmp`). `slicer.data` ceases
to exist as a build artifact.

Changes cascaded through the stack:

| Component | Change |
|-----------|--------|
| `orca-wasm/wasm/CMakeLists.txt` | Removed `--preload-file orca/resources`, added `-sFORCE_FILESYSTEM=1` |
| `deploy.yml` | Removed part-splitting step (nothing to split) |
| `slicer.worker.ts` | Removed `.part0/.part1` reassembly patch |
| `scripts/download-wasm.mjs` | Downloads only `slicer.js` + `slicer.wasm` |

## Consequences

- **Positive:** `slicer.data` 200 MB → **0 bytes**. Total WASM download: ~31 MB
  (`slicer.js` ~1.5 MB + `slicer.wasm` ~29 MB), cached after first visit.
- **Positive:** Faster module startup — no MEMFS population phase.
- **Positive:** Simpler deploy pipeline — no file splitting, no git LFS.
- **Positive:** No GitHub 100 MB-per-file constraint to work around.
- **Constraint:** Config must remain JS-side (`profiles.ts`). Any future feature
  requiring OrcaSlicer's built-in preset files would need a different approach
  (e.g. shipping selected JSON separately, not via preload-file).
