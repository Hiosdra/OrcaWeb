# ADR-002: Technology Stack

**Status:** Accepted  
**Date:** 2026-06-09

## Context

After deciding on client-side WASM (ADR-001), we needed to choose a frontend
stack for the UI layer. Requirements:

- Fast development iteration
- TypeScript support (WASM interop requires careful typing)
- Good 3D rendering story for STL preview and G-code viewer
- Responsive / mobile-friendly out of the box
- Active ecosystem with long-term viability

## Decision

| Layer | Choice | Version |
|-------|--------|---------|
| UI Framework | React | 19 |
| Build tool | Vite | 5 |
| Language | TypeScript | 5 |
| Styling | Tailwind CSS | v4 |
| 3D rendering | Three.js | 0.170 |
| WASM runtime | Emscripten (OrcaSlicer core) | — |
| Worker | Web Worker (ES module) | native |

## Rationale

**React + Vite + TypeScript** — the standard choice for new React projects in 2026.
Vite handles Web Worker bundling natively (`?worker` import), produces ES module
workers, and supports the COOP/COEP headers needed for `SharedArrayBuffer`
(future-proofing, even though current WASM is single-threaded).

**Tailwind CSS v4** — utility-first CSS avoids bespoke style sheets; v4 uses a
native CSS engine (no PostCSS required), ideal for a minimal-dependency project.

**Three.js** — the dominant WebGL library for browser 3D. `STLLoader` and
`OrbitControls` are battle-tested; `LineSegments2` + `LineMaterial` from
`three/examples` provide sub-pixel-accurate G-code toolpath rendering.

## Consequences

- **Positive:** Large ecosystem, easy to find contributors, excellent tooling.
- **Positive:** Vite's ESM worker support (`?worker`) means zero custom worker-loading
  boilerplate.
- **Negative:** Three.js adds ~600 KB to the bundle; this is acceptable given the
  WASM size already dominates the download budget.
- **Note (historical):** Early prototypes used Tailwind v3. Migration to v4
  happened as part of the MVP work.
