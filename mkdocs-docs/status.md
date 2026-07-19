# Status — what works, what doesn't

This page describes the current state of the project: implemented features and known limitations. Planned-but-not-yet-implemented work lives in GitHub issues, linked below, instead of an in-page roadmap.

Last updated: **2026-07-19** · engine version: **OrcaSlicer v2.4.2** (self-built, live in production) · app version: **v0.7.60**

---

## ✅ Works

### User interface

| Feature | Notes |
|---------|-------|
| Drag & drop STL | ASCII and binary STL; multiple files at once — sequential queue, each G-code downloadable separately |
| 3MF import | Engine-side read (`orc_read_3mf`, OrcaSlicer's native reader — applies per-object/instance transforms correctly); no JS fallback — an engine failure surfaces as an import error |
| OBJ import | OBJ → STL conversion via OrcaSlicer's native parser (`objparser.cpp` + `OBJ.cpp`) compiled into WASM — no extra dependencies; supports triangles, quads, multi-object |
| STEP import | STEP → STL conversion via OCCT 7.8.1 compiled directly into `slicer.wasm` (`Model::read_from_step`); no separate download. IGES unsupported (OrcaSlicer's STEP reader doesn't read IGES) |
| 3D model preview (Three.js) | Model on a virtual print bed at real mm scale, OrbitControls |
| Bed grid — dynamic size | Bed size read from the printer preset or machine profile |
| Bed shape (`bed_shape`) | Rectangular or circular (e.g. Bambu Lab P1S); visualised in both the 3D preview and G-code viewer |
| Fuzzy skin (surface roughness) | Modes: none / external (outer walls only) / all; thickness 0.05–2 mm, point spacing 0.1–5 mm; libnoise compiled for WASM (Perlin/Billow/RidgedMulti/Voronoi) — since PR #32 |
| Multi-file — sequential queue | Drag & drop multiple files → each sliced separately, own G-code to download |
| Multi-file — one plate | "One plate (N)" button — all STLs auto-arranged via `arrange_objects()` (libnest2d), one G-code |
| Model / Settings / Slice tabs | Smooth navigation, tabs locked until a file is loaded |
| Settings panel | Printer, filament, and quality selection |
| G-code preview (layer by layer) | Layer slider, colouring by move type (perimeter/infill/support/travel), thick 3D lines, layer cursor — since PR #16 |
| G-code preview — both comment dialects | Layers from `;LAYER_CHANGE` / `; CHANGE_LAYER` markers, move types from `;TYPE:` **and** `; FEATURE:` (Bambu dialect — type colours previously didn't work for BBL printers), `G2`/`G3` arc tessellation, correct vase/spiral mode rendering |
| G-code statistics | Print time, layers, filament (mm/g) on the file card — parsed from the G-code header and footer (both time-comment dialects) |
| Side-by-side model + G-code view | Synchronised layout after slicing |
| G-code download | "Download" button with the correct filename; "Download All (.zip)" bundles every result into one archive |
| .3mf export | ".3mf" button on a sliced card — the engine writes the mesh + embedded OrcaSlicer settings (`orc_write_3mf`); no bed/G-code/thumbnail data (see below) |
| Slice cancellation | "Cancel" button — restarts the worker (the synchronous WASM slice loop can't be interrupted any other way); pending OBJ/STEP conversions are retried automatically |
| Stale-result detection | Changing settings after slicing marks a result "Sliced with previous settings"; the button becomes "Re-slice" |
| Settings persistence | Printer, filament, quality preset, and overrides kept in `localStorage`, restored on the next visit |
| Queue as a state machine | `useSliceQueue` (reducer) — correlates worker responses by `requestId`; an engine error fails every pending item instead of leaving spinners running forever |
| Engine status badge | "Loading engine…" / "Engine error" in the header |
| Engine version in header | `v{app} · {date} · engine v{orca}` under the logo — same text at every screen width |
| Footer — source link (AGPL) | Visible "Source (AGPL-3.0)" link → GitHub repo |

### WASM engine

| Feature | Notes |
|---------|-------|
| STL → G-code slicing | Runs in a Web Worker, doesn't block the UI |
| Self-built OrcaSlicer **v2.4.2** | Built via `orca-wasm/` + Emscripten; artifacts in the `wasm-v2.4.2` release |
| ST / MT engine variants | Single-threaded (ST, `slicer.js`/`slicer.wasm`) served everywhere; multithreaded (MT, `slicer-mt.js`/`slicer-mt.wasm`, real oneTBB) served only where the page is cross-origin isolated (currently the Cloudflare mirror) — see [ADR-011](adr/adr-011-multithreaded-engine.md) and the [ST vs MT benchmark](st-mt-benchmark.md) |
| `orc_obj_to_stl` | WASM export: OBJ → binary STL conversion without needing `orc_init`; result returned as an `ArrayBuffer` to the worker |
| `orc_slice_multi` | Multiple STLs → one G-code: auto-arrange via `arrange_objects()` (libnest2d + NLopt); output identical in shape to `orc_slice` |
| `orc_write_3mf` | WASM export: writes the mesh + embedded config as `.3mf` via `Slic3r::store_bbs_3mf()` — no plate/G-code/thumbnail data (no `PartPlateList` in the headless bridge); verified by the smoke test (ZIP unpacks, `3D/3dmodel.model` + `Metadata/*.config` present) |
| `orc_read_3mf` | WASM import: reads `.3mf` via `Slic3r::load_bbs_3mf()` — merged binary STL (per-instance/volume transforms applied by `ModelObject::mesh()`) + config JSON (same keys as OrcaSlicer's native `.config`, parsed by the existing `parseOrcaProfileJson()`); verified by the smoke test (round-trip: triangle count + config keys) |
| No `slicer.data` | The headless flat-config slicer never reads `orca/resources` → data file reduced **200 MB → 0** |
| Singleton worker | One worker for the whole session |
| Error handling | Error codes `-1`…`-9`, readable messages |
| WASM load while slicing is requested | `SLICE` requests are queued while WASM is still loading |
| Streaming WASM compile | `WebAssembly.compileStreaming` compiles `slicer.wasm` in parallel with the download (and with fetching `slicer.js`); falls back to buffered `compile` on a wrong Content-Type |
| G-code JPEG thumbnails | Real JPEG (RGBA→RGB, standard libjpeg) — since PR #13 |
| Slice timer | Button shows `Slicing… (12s)` — honest elapsed time, no fake stage names — since PR #15 |
| PWA / offline mode | Service Worker (Workbox) pre-caches all assets + WASM on first visit; installable as a native app |
| Session-scoped engine (`orc_session_create`/`orc_session_destroy`) | Engine state (config, bed, last error) moved from global C++ statics to a session handle — see [ADR-008](adr/adr-008-session-handle.md) |
| WASM crash recovery | `onAbort` reliably reports `WASM_ERROR` to the main thread; the dead worker is dropped and replaced with a fresh one on the next attempt |
| Engine smoke test in CI | `orca-wasm/scripts/smoke-test.mjs` — real `orc_init`/`orc_slice(_multi)` after every build, before publishing a release — see [ADR-009](adr/adr-009-wasm-smoke-test.md) |
| E2E UI smoke test in CI | Playwright (`e2e/slice.spec.ts`) — uploads the real Voron Design Cube v7 model → slices → gets G-code through the real WASM engine, on every open PR — see [ADR-010](adr/adr-010-e2e-smoke-test.md) |

### Engine clean layer (patches vs. overrides)

OrcaSlicer's C++ source is patched in place (`orca-wasm/patches/apply.py`) for WASM-compatibility fixes (narrowing, ABI, platform guards), while whole files whose implementation depends on a library unavailable in WASM (OCCT-dependent SVG/text export, OpenVDB, OpenCV, Draco) are replaced wholesale by no-op overrides in `orca-wasm/overrides/`. These are two distinct mechanisms — see [ADR-006](adr/adr-006-patch-strategy.md) for the full three-layer strategy (header shims + C++ overrides + in-place patches) and [architecture.md](architecture.md#engine-clean-layer-override-approach) for the current table of stubs.

| Aspect | Details |
|--------|---------|
| Disabled WASM dependencies | OpenVDB, OpenCV, Draco replaced by overrides; OCCT and libnoise **are** compiled in |
| Upgrading to a new version | Just `ORCA_VERSION` in the workflow, plus any stub adjustments |
| AGPL-3.0 compliance | `LICENSE`, `NOTICE.md`, source link in the UI — §13 network copyleft satisfied |

### OrcaSlicer profiles

| Feature | Notes |
|---------|-------|
| Built-in quality presets | Draft (0.3 mm) / Standard (0.2 mm) / Fine (0.1 mm) |
| Built-in filaments | PLA, PETG, ABS, TPU |
| Built-in printers | Generic 0.4/0.6, Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4 |
| JSON profile import from OrcaSlicer | `.json` file from a desktop install; `ORCA_FIELD_MAP` mapping + passthrough of all other fields |
| Machine profile import | `gcode_flavor`, `retract_length/speed`, `lift_z`, `machine_start/end_gcode`, `machine_max_speed_*`, `printable_height` — all reach the engine |
| Profile extraction from 3MF | Via `orc_read_3mf` (falls back to a JS read of `Metadata/*.json/.config` from the archive if the engine fails) |

### Deployment

| Aspect | Status |
|--------|--------|
| GitHub Actions CI (deploy.yml) | ✅ builds and deploys on every push to `master` |
| PR snapshot on GitHub Pages | ✅ `pr-preview.yml` publishes `previews/pr-<number>/`, comments the URL, removes the snapshot when the PR closes; same-repository branches only |
| Same-origin WASM serving | ✅ no CORS — files live in `gh-pages/app/wasm/` |
| WASM release `wasm-v2.4.2` | ✅ `slicer.js` + `slicer.wasm` (~29 MB total, includes OCCT for STEP) |
| Deploy resilience | ✅ falls back to the previous `gh-pages` state if the release is missing |
| CI build on PRs touching `orca-wasm/**` | ✅ every PR touching the engine runs a ~12 min build |
| E2E smoke test on PRs (`e2e-smoke.yml`) | ✅ every open PR — downloads the published WASM engine and slices the Voron Design Cube v7 through the real UI (Playwright) |
| App version auto-bump | ✅ every deploy bumps the patch version in `package.json`/`status.md` and tags `vX.Y.Z` automatically (see the `/release` skill for a deliberate minor/major bump) |
| Engine auto-rebuild on `orca-wasm/` changes | ✅ a push to `master` touching `orca-wasm/**` triggers `build-wasm.yml`; `deploy.yml` waits for its result (`workflow_run`) instead of racing an older engine |
| Landing page | ✅ `hiosdra.github.io/OrcaWeb/` |
| MkDocs documentation | ✅ `hiosdra.github.io/OrcaWeb/docs/` |
| Dependabot + dependency grouping | ✅ weekly schedule |

---

## ⚠️ Partially working / known limitations

| Area | Details |
|------|---------|
| Printer temperature ranges | Not independently verified — printer+filament preset combinations may be inconsistent for exotic pairings |
| Large STL files (>50 MB) | May cause stutter during preview |

### Multi-extruder / multi-material

The bridge exposes `orc_slice_multi`'s `extruder_ids` — per-object assignment to OrcaSlicer's `"extruder"` config key (`ModelConfig::set`, `PrintConfig.cpp`), which the engine already normalises to `*_filament_id` (`normalize_fdm()`). This is the "single nozzle, multiple filament slots" (AMS-style) path — it does **not** touch `nozzle_diameter`, so it doesn't exercise `support_different_extruders()`, the code path behind a previously confirmed crash on a real Bambu Lab H2D profile (see `isMultiExtruderProfile()` in `src/lib/profiles.ts` and [ADR-008](adr/adr-008-session-handle.md)).

| Item | Status |
|------|--------|
| Bridge: `orc_slice_multi(..., extruder_ids, ...)` | ✅ implemented, verified by the smoke test ("plate: 2 objects, per-object extruder override") |
| Real multi-nozzle printers + per-object extruder/filament assignment UI | ❌ deliberately blocked — see [#141](https://github.com/Hiosdra/OrcaWeb/issues/141) |

---

## Not yet implemented

Tracked in GitHub issues rather than listed here, so this page doesn't drift into a stale roadmap:

- [#138](https://github.com/Hiosdra/OrcaWeb/issues/138) — Variable layer height
- [#139](https://github.com/Hiosdra/OrcaWeb/issues/139) — Support enforcement / blocking
- [#141](https://github.com/Hiosdra/OrcaWeb/issues/141) — Real multi-nozzle / multi-extruder printers
- [#108](https://github.com/Hiosdra/OrcaWeb/issues/108) — Full "sliced project" 3MF export (per-plate G-code, plate thumbnails); `orc_write_3mf`/`orc_read_3mf` intentionally cover mesh + embedded config only, since the headless bridge has no `PartPlateList` to source that from — this is a documented non-goal for the current bridge shape, not a plain backlog item

---

## Architecture note

There is no `cli/` directory — a Node CLI wrapper existed early on and was deliberately removed in its entirety (`chore: remove CLI` — frontend → bridge → engine only). It is not a project goal; see [agents.md](https://github.com/Hiosdra/OrcaWeb/blob/master/agents.md#project-vision). For the current component breakdown, see [architecture.md](architecture.md).
