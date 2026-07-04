# ADR-008: Session-Scoped Engine State

**Status:** Accepted  
**Date:** 2026-07-04

## Context

`orca-wasm/bridge/slicer.cpp` kept all engine state — the active `DynamicPrintConfig`,
an `initialized` flag, the bed centre/shape, and the last error message — in
process-wide C++ statics (`g_config`, `g_initialized`, `g_bed_cx`/`g_bed_cy`,
`g_bed_shape`, `g_last_error`). `orc_init()` wrote to them; `orc_slice()` /
`orc_slice_multi()` read them.

This was safe as long as exactly one JS caller ever touched the module: a single
Web Worker, processing `SLICE`/`SLICE_MULTI` messages strictly one at a time
(JavaScript's single-threaded event loop already serializes them). But it made
the bridge structurally unsafe for any future caller that wants more than one
logical slicer job alive in the same WASM instance — a Node CLI batch-processing
many files in one process, or a future multi-worker pool arranging several
plates in parallel. Two overlapping `orc_init()` calls would silently clobber
each other's config with no error, no matter how far in the future that caller
arrives.

## Decision

Move `config`, `initialized`, `bed_cx`/`bed_cy`, `bed_shape`, and `last_error`
into an `OrcSession` struct, allocated on the heap and referenced by an opaque
`void*` handle:

```c
void*  orc_session_create();          // 0 = allocation failed
void   orc_session_destroy(void* session);
int    orc_init(void* session, const char* json, int len);
int    orc_slice(void* session, ...);
int    orc_slice_multi(void* session, ...);
const char* orc_decode_exception(void* session);
```

`orc_obj_to_stl` / `orc_cad_to_stl` are untouched — they are pure format
conversions with no config state, so they take no session. `orc_decode_exception`
already had an unused `void*` parameter (`orc_decode_exception(void* /*unused*/)`);
passing `0`/null there now falls back to a small dedicated error slot used only
by those two conversion functions, so their existing JS call pattern
(`_orc_decode_exception(0)`) keeps working unchanged.

`src/workers/slicer.worker.ts` creates exactly one session right after the WASM
module loads and reuses it for the worker's entire lifetime — behaviourally
identical to the old global-state bridge. Only the storage changed.

### Alternatives considered

- **Do nothing, document the constraint.** Cheapest, but leaves the footgun in
  place for whichever future change tries to run two jobs concurrently — chosen
  against, since the real fix was a small, mechanical, low-risk change with the
  smoke test (ADR-009) available to guard it.
- **Real OS threads (Emscripten pthreads + SharedArrayBuffer).** Would allow
  genuinely parallel sessions, not just safely-interleaved ones. Rejected for
  now: it needs COOP/COEP response headers for cross-origin isolation, which
  GitHub Pages (the current deploy target — see `architecture.md`) cannot serve
  since it's a static host with no custom headers. ADR-007 already chose
  sequential TBB stubs deliberately; revisiting that is a separate, larger
  decision this ADR does not make.

## Consequences

- **Positive:** A future Node CLI or worker pool can hold multiple independent
  slicer sessions in one WASM instance without cross-contamination.
- **Positive:** `orc_slice_multi` also gained a per-object `extruder_ids`
  parameter alongside this refactor (see `orca-wasm/bridge/slicer.cpp`'s doc
  comment on `orc_slice_multi` and `status.md`'s "Multi-ekstruder / multi-material"
  section) — unrelated to session scoping itself, but landed in the same pass
  since both touch the same function signatures.
- **Neutral:** Purely mechanical change — no algorithmic difference, verified by
  re-checking every `record_error`/state-access call site by hand (this repo's
  sandbox has no Emscripten toolchain to compile against locally; CI's
  `build-wasm.yml`, which does have one, is the first real compiler check this
  change gets — see the "Smoke test" step added in ADR-009).
- **Negative:** One more parameter to thread through every bridge call and
  every `wasm-loader.ts` function. Small, permanent readability cost.
