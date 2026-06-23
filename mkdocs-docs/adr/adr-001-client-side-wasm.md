# ADR-001: Client-Side WASM Architecture

**Status:** Accepted  
**Date:** 2026-06-09

## Context

We wanted to build a browser-based slicer inspired by Prusa EasyPrint, but with
full OrcaSlicer profile support. The fundamental question was where to run the
slicing computation:

- **Cloud/server approach** — user uploads STL to a server, server runs OrcaSlicer
  natively, returns G-code (the Prusa EasyPrint model).
- **Client-side WASM approach** — OrcaSlicer core compiled to WebAssembly, slicing
  runs entirely inside the user's browser.

Research showed that `orcaslicer-wasm` (an existing project) had already proved
it was possible to compile OrcaSlicer v2.3.x to WebAssembly via Emscripten and
produce correct G-code in a browser environment.

## Decision

Run all slicing computation **client-side via WebAssembly**. No server is involved
in the slice pipeline; user files never leave the device.

## Rationale

| Criterion | Cloud | Client WASM |
|-----------|-------|-------------|
| Privacy | Files sent to server | Files stay on device ✅ |
| Offline use | Requires internet | Works offline ✅ |
| Infrastructure cost | Server + scaling | Zero ✅ |
| First-load size | Tiny HTML | ~9 MB WASM (cached) |
| Raw compute | Native speed | ~1–2× slower (WASM) |

The ~9 MB one-time WASM download is cached by the browser (and Service Worker),
making subsequent uses instant. Slicing a typical model takes 50–500 ms in WASM
— well within acceptable interactive latency.

## Consequences

- **Positive:** Zero privacy concerns, works offline, no backend to maintain.
- **Positive:** Open-source stack end-to-end.
- **Negative:** First visit requires downloading `slicer.js` (~1.5 MB) + `slicer.wasm`
  (~29 MB after our v2.4.0 build). PWA Service Worker pre-caches these on install.
- **Negative:** Very large STL files (>50 MB) may cause viewer jank on low-end devices.
- **Constraint:** WASM is single-threaded (no SharedArrayBuffer required), so all
  parallel TBB algorithms must be replaced with sequential equivalents (see ADR-007).
