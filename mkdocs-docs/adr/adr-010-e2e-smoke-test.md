# ADR-010: E2E UI Smoke Test with the Real WASM Engine

**Status:** Accepted
**Date:** 2026-07-05

## Context

ADR-009 added `orca-wasm/scripts/smoke-test.mjs`, a Node script that loads
`slicer.js`/`slicer.wasm` directly and calls `_orc_init`/`_orc_slice` to catch
an engine that compiles but traps on a real slice. It only runs in
`build-wasm.yml`, which is path-filtered to `orca-wasm/**` — a normal UI PR
never triggers it, and it never touches the actual app path a real user
exercises: `FileUpload` → `App.tsx`'s queue state machine →
`worker-singleton.ts` → `slicer.worker.ts`'s message protocol → the WASM
module. A regression in that glue code (a broken `postMessage` payload, a
worker that never spawns, a UI state that gets stuck on `loading-wasm`) would
compile fine, pass the Node-level smoke test, and still ship broken.

## Decision

Add a Playwright E2E test (`e2e/slice.spec.ts`) that drives the real browser
UI end-to-end against a real compiled engine:

1. Load the app, upload a synthetic 12-triangle STL cube (`e2e/fixtures/cube-stl.ts`
   — generated in memory, same no-vendored-model rationale as ADR-009's
   icosphere generator).
2. Navigate to the Slice tab and click "Slice All".
3. Wait for the queue item to reach `Done` (cold engine load + a real slice,
   generous timeout) and assert the download button appears.
4. Assert no browser console errors occurred during the whole flow.

`data-testid` attributes were added to the file input, tab buttons, slice
button, queue item status, and download button (`src/components/FileUpload.tsx`,
`src/App.tsx`) so the test doesn't depend on copy text.

Wired into a new `.github/workflows/e2e-smoke.yml`, triggered on **every**
`pull_request` (no path filter, unlike `build-wasm.yml`) — a UI-only change is
exactly what this test exists to catch. It downloads the latest *published*
engine release via `npm run setup` (the same script local dev uses) rather
than building from source: engine-source correctness is already gated by
`build-wasm.yml`'s own smoke test before anything is ever published, so this
test only needs a real, working binary to drive the UI against, not the one
the current PR might be building.

Runs against `npm run dev` (not `vite preview`) because the required
COOP/COEP headers (`vite.config.ts`) are configured under `server`, not
`preview`.

## Consequences

- **Positive:** Catches breakage in the worker/UI integration layer that the
  Node-level smoke test structurally cannot see, on every PR rather than only
  ones touching `orca-wasm/**`.
- **Positive:** Runs against a real engine binary, not a mock — closer to
  what a user's browser actually does.
- **Negative / accepted scope:** Tests against the latest published engine
  release, not a WASM change made in the same PR (that PR's `build-wasm.yml`
  run validates the engine itself; the two checks are complementary, not
  redundant).
- **Negative:** Adds a Chromium download + a dev-server boot + one slice to
  every PR's CI — a few minutes, not the multi-hour cost of `build-wasm.yml`.
