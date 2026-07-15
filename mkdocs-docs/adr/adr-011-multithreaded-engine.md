# ADR-011: Multithreaded Engine Variant (Real oneTBB) on the Cloudflare Mirror

**Status:** Accepted
**Date:** 2026-07-14

## Context

ADR-007 replaced TBB with sequential stub headers because real threading in
WASM requires `SharedArrayBuffer`, which requires `Cross-Origin-Opener-Policy:
same-origin` + `Cross-Origin-Embedder-Policy: require-corp` response headers
— and the primary deployment, GitHub Pages, cannot send custom response
headers at all. ADR-007 left this as future work, contingent on a host that
actually can send those headers.

That host now exists: the Cloudflare Workers static-assets mirror
(`wrangler.jsonc`, `scripts/cf-build.mjs`), added as a secondary deployment
alongside GitHub Pages. Cloudflare *can* set arbitrary response headers via a
`_headers` file, which reopens the threading question ADR-007 deferred.

## Decision

Build and ship a second, real-oneTBB engine variant (`slicer-mt.js` /
`slicer-mt.wasm`), served only where cross-origin isolation is actually
available.

**Engine build** (`.github/workflows/build-wasm.yml`, `variant: [st, mt]`
matrix): the `mt` leg builds real `oneTBB` v2021.13.2
(`uxlfoundation/oneTBB`) from source for `wasm32-emscripten`, then links
`libslic3r` against it with `-pthread -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=8`
(pre-spawned pool — the slicer's calling thread never yields to the JS event
loop, so lazily-created pthread workers would never materialize). The `st`
leg is unchanged. Both legs are smoke-tested independently before
publishing, and a `compare-outputs` job slices a fixed mesh set through both
and requires matching G-code toolpath structure within a numeric tolerance
(real parallel reductions can legitimately reorder floating-point summation,
so byte-identical output is not required). See `orca-wasm/MT-PLAN.md` for
the full design.

**Deployment topology** — GitHub Pages stays single-threaded, Cloudflare
gets both:
- `deploy.yml` now also resolves and downloads the `-multithreaded` release
  family and mirrors `slicer-mt.*` onto GitHub Pages, best-effort (a missing
  MT release never fails the deploy — GitHub Pages never runs it anyway).
- `public/_headers` sends COOP/COEP on the Cloudflare mirror only —
  Cloudflare cannot host either 36 MB engine binary itself (both exceed
  Workers/Pages' 25 MiB per-asset limit), so `cf-build.mjs` points
  `VITE_WASM_BASE_URL` at the GitHub Pages copies and the app loads them
  **cross-origin**. This works specifically because GitHub Pages serves them
  with `Access-Control-Allow-Origin: *` (verified live), which satisfies
  COEP `require-corp` for a CORS-mode fetch. Plain GitHub **Releases**
  assets do not: verified live, they redirect through a signed, expiring
  Azure Blob URL with neither `Access-Control-Allow-Origin` nor
  `Cross-Origin-Resource-Policy`, so they cannot be read cross-origin under
  COEP at all — mirroring onto GitHub Pages isn't an implementation
  convenience, it's the only way the MT binary can reach an isolated page.
- At runtime, `src/workers/slicer.worker.ts` checks
  `self.crossOriginIsolated`, then probes for `slicer-mt.js` on the
  resolved WASM base URL, falling back to the always-available ST engine on
  any failure (missing file, network error, or a non-JS response such as an
  SPA-fallback HTML page). GitHub Pages visitors are never isolated, so they
  always get ST, unchanged from before this ADR.

## Consequences

- **Positive:** Real multi-core slicing throughput on the Cloudflare mirror,
  without touching the primary GitHub Pages deployment's behavior at all.
- **Positive:** The dual-build/compare/probe-and-fallback design means a
  broken or unpublished MT release degrades gracefully to ST everywhere,
  including on Cloudflare.
- **Negative:** Doubles `build-wasm.yml`'s CI cost (two full matrix legs,
  each ~1–4 hours) and doubles the WASM storage footprint in GitHub
  Releases and on GitHub Pages.
- **Negative:** The Cloudflare→GitHub-Pages cross-origin load path is
  exercised by CI's same-origin dev-server checks and by the
  `compare-outputs` G-code check, but the actual cross-origin fetch under
  COEP is only proven on a real Cloudflare deploy, not locally (the Vite dev
  server serves the engine same-origin).
- **Accepted scope:** GitHub Pages remains permanently ST-only — it cannot
  send custom headers, so there is no path to running MT there without a
  different primary host.
- **Found and fixed during implementation:** the bridge's custom
  `instantiateWasm` hook originally passed only the instantiated
  `WebAssembly.Instance` to Emscripten's `successCallback`, not the compiled
  `WebAssembly.Module`. Emscripten's pthread worker spawning depends on the
  module reference the callback is supposed to supply, so this made the MT
  engine crash on every real browser load (100% failure) despite compiling
  cleanly and passing the Node-level smoke test, which doesn't exercise this
  hook the same way. Fixed; see `orca-wasm/MT-PLAN.md`.
- **Found during implementation — MT deadlocked from pthread-pool
  exhaustion; fix required two tries.** Confirmed on real Chrome: the MT
  engine hung 130+ s and never completed on a trivial 10 mm cube (~1–2s on
  ST), near-idle CPU (~1.2 CPU-seconds/5s) — a deadlock. oneTBB created
  ~`hardware_concurrency` worker pthreads on the first `parallel_for`,
  exhausting the 8-slot pool; the on-demand grow-the-pool path can't complete
  while the slicer thread is blocked, so the extra workers hung. The first fix
  attempt (cap TBB to 8 via `tbb::global_control`, pool 16) **passed CI but
  still deadlocked on 16 cores** — the cap starved oneTBB's nested parallelism
  and hung even with a 64-slot pool (verified: fully idle). CI missed it
  because its runners have 2–4 cores, below both the cap and the pool. The
  landed fix removes the cap and instead sizes the pool to the machine
  (`-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4`). It was **verified**
  by downloading the CI-built artifact and driving it on the 16-core machine:
  no deadlock, and the full ST-vs-MT benchmark completed. See
  `orca-wasm/MT-PLAN.md`. **Because low-core CI cannot reproduce this class of
  hang, every future engine change here must be re-verified against the
  CI-built binary on a many-core machine.** The fix lives in the engine binary,
  so enable the Cloudflare COOP/COEP deployment only after a merge publishes
  the rebuilt `*-multithreaded` release and `deploy.yml` mirrors it.
