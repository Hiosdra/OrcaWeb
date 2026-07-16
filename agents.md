# OrcaWeb — agents.md

AI coding agent instructions for this project.

## Documentation rule

**All documentation lives in `mkdocs-docs/` and is published via MkDocs.**

- `mkdocs-docs/architecture.md` — update when the architecture, WASM API, file structure, or key dependencies change
- `mkdocs-docs/status.md` — update the feature checklist and version when shipping a release
- `mkdocs-docs/adr/` — add a new ADR when a significant architectural decision is made
- `mkdocs-docs/integration.md` + `mkdocs-docs/api-reference.md` — update when a bridge export (`orc_*`) is added, removed, or changes signature
- If a change affects the **ST vs MT engine split** specifically (thread pool sizing, `SLIC3R_WASM_MT`, COOP/COEP/deployment requirements, the ST/MT probe-and-fallback logic) — update [ADR-011](mkdocs-docs/adr/adr-011-multithreaded-engine.md) rather than adding a new standalone design doc; it's the single source of truth for MT design constraints (see #110 — this is exactly the kind of doc that used to drift into a second file)

If you touch the WASM pipeline, CI workflow, shims, or UI — check whether any `mkdocs-docs/` file needs updating before closing the task.

### When to touch which doc

| You changed... | Update... |
|---|---|
| WASM bridge exports (`orca-wasm/bridge/slicer.cpp`) | `integration.md`, `api-reference.md`, `orca-wasm/README.md` (C API section) |
| Build pipeline / shims / overrides / patches | `architecture.md` (engine clean layer), `wasm-build.md` |
| ST/MT engine split, thread pool, deployment headers | `ADR-011` only — not a new file |
| A shipped feature (UI or engine) | `status.md`'s feature table |
| A significant architectural decision | A new file in `mkdocs-docs/adr/` + a row in `adr/index.md` |
| Anything under `mkdocs-docs/**` | Run `mkdocs build --strict` locally (or let CI do it — see `ci.yml`) before opening the PR, to catch broken internal links |

## Setup

```bash
npm install
node scripts/download-wasm.mjs   # downloads ~29 MB WASM artifacts (slicer.js + slicer.wasm) into public/wasm/
npm run dev                      # Vite dev server at http://localhost:5173
```

WASM artifacts (`public/wasm/`) are gitignored — run the download script after a fresh clone.

## Project vision

**The main product is the WASM slicer engine — a fully working OrcaSlicer compiled to WebAssembly.**

The React frontend (`src/`) is a temporary PoC to demonstrate the engine. It is not the end goal. Design decisions, dependency choices, and feature work should prioritise making the WASM engine complete and correct — all slicer features working (fuzzy skin, supports, infill, etc.) — over the web UI.

The target end-state is a fully working, embeddable OrcaSlicer WASM engine — not necessarily a CLI. A Node CLI wrapper existed early on and was deliberately removed (`chore: remove CLI` — frontend → bridge → engine only); it is not a project goal.

## Architecture

- **React 19 + TypeScript + Vite + Tailwind CSS v4** — frontend in `src/` (temporary PoC)
- **Web Worker** (`src/workers/slicer.worker.ts`) — runs OrcaSlicer WASM off the main thread
- **WASM engine** — OrcaSlicer compiled via Emscripten; artifacts in `public/wasm/`; this is the core deliverable
- **WASM build pipeline** — `orca-wasm/` contains the Emscripten build, CMake config, shims, and patch script (`orca-wasm/patches/apply.py`)

Detailed architecture: [`mkdocs-docs/architecture.md`](mkdocs-docs/architecture.md)  
Architecture decisions (ADRs): [`mkdocs-docs/adr/index.md`](mkdocs-docs/adr/index.md)

## WASM build

CI builds the WASM engine via `.github/workflows/build-wasm.yml`, as two variants: single-threaded (ST — `slicer.js`/`slicer.wasm`, served everywhere) and multithreaded (MT — `slicer-mt.js`/`slicer-mt.wasm`, real oneTBB, served only on cross-origin-isolated hosts such as the Cloudflare mirror). See [ADR-011](mkdocs-docs/adr/adr-011-multithreaded-engine.md).

Key pieces:
- `orca-wasm/patches/apply.py` — regex patches applied to OrcaSlicer source before cmake
- `orca-wasm/cmake/wasm_find_paths.cmake` — loaded via `CMAKE_PROJECT_INCLUDE_BEFORE`; sets compile definitions (`SLIC3R_WASM`, `SLIC3R_NO_OCCT`, `SLIC3R_NO_OPENVDB`, `SLIC3R_NO_OPENCV`)
- `orca-wasm/wasm/shims/` — header-only TBB stubs (ST engine) and other WASM compatibility shims

## Code style

- TypeScript strict mode
- No `any` without justification
- Prefer editing existing files over creating new ones
- No comments unless the **why** is non-obvious

## Commit style

Conventional commits: `feat`, `fix`, `chore`, `docs`, `refactor`.  
Scope examples: `(wasm)`, `(ui)`, `(ci)`.

## Releasing

Use the `/release` skill to cut a new app version. It handles:

1. `package.json` version bump
2. `mkdocs-docs/status.md` — updates the `Last updated` date and `app version`
3. Commit (`chore(release): bump to vX.Y.Z`) + optional push + GitHub tag

> WASM engine releases are separate — trigger `build-wasm.yml` manually with the
> new OrcaSlicer tag when the engine version changes.

## PR checklist

- [ ] `mkdocs-docs/` updated if architecture or a major feature changed (see "When to touch which doc" above)
- [ ] Types pass (`npm run typecheck` or `tsc --noEmit`)
- [ ] No console errors in the browser on the happy path
- [ ] If you touched `FileUpload`/`App.tsx`/worker/WASM-loading code, run `npm run test:e2e` locally (needs `npm run setup` + `npx playwright install chromium` first) — this also runs on every PR via `.github/workflows/e2e-smoke.yml`
- [ ] If you touched `mkdocs-docs/**`, `mkdocs build --strict` passes (CI enforces this on every PR — see `ci.yml`'s `docs` job)
