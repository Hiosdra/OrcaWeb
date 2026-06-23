# ADR-003: Web Worker Isolation + Singleton Pattern

**Status:** Accepted  
**Date:** 2026-06-09

## Context

Two related problems arose during the initial Web UI integration:

### Problem 1 — Main thread blocking

`_orc_slice()` runs synchronously inside the WASM module and takes 50–500 ms
depending on model complexity. Calling it on the main thread freezes the browser
UI for that duration.

### Problem 2 — Race condition in WASM loading

An early implementation sent `LOAD_WASM` and then fired `SLICE` with a hardcoded
500 ms `setTimeout`:

```typescript
// ❌ Broken: races if slicer.data > 500 ms to download
worker.postMessage({ type: 'LOAD_WASM', url: '/wasm/slicer.js' })
setTimeout(() => {
  worker.postMessage({ type: 'SLICE', stl: stlBuffer, config })
}, 500)
```

This silently dropped slice requests when WASM hadn't finished loading yet.

### Problem 3 — React StrictMode double worker

React StrictMode mounts components twice in development. This caused two workers
to be created, each independently downloading and initialising the ~9 MB WASM
binary — wasting bandwidth and memory.

## Decision

**Web Worker (`src/workers/slicer.worker.ts`)** isolates all WASM execution from
the main thread. The worker protocol is fully event-driven:

```
Main → Worker:  LOAD_WASM | SLICE
Worker → Main:  WASM_LOADED | WASM_ERROR | SLICE_COMPLETE | SLICE_ERROR
```

If a `SLICE` message arrives before `WASM_LOADED`, the worker queues it in
`pendingSlice` and replays it automatically once the module is ready.

**Singleton (`src/lib/worker-singleton.ts`)** is a module-level variable that
holds the single `Worker` instance for the entire browser session:

```typescript
let worker: Worker | null = null

export function getWorker(): Worker {
  if (!worker) worker = new Worker(...)
  return worker
}
```

`preloadWasm()` is called in `main.tsx` before the React tree renders, so WASM
starts downloading before the user interacts with anything.

## Consequences

- **Positive:** UI stays responsive during slicing.
- **Positive:** No race condition — WASM loading is event-driven, not timer-based.
- **Positive:** Exactly one WASM instance per browser session regardless of
  React StrictMode or HMR.
- **Positive:** WASM pre-loading begins at app startup, reducing perceived latency
  on first slice.
- **Negative:** Module-level singletons are harder to test in isolation; in
  practice the worker is treated as a long-lived process, which is appropriate.
