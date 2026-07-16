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
available. The C bridge API is unchanged — OrcaSlicer continues to call the
same TBB API it already uses; only what's linked behind it differs.

**Engine build** (`.github/workflows/build-wasm.yml`, `variant: [st, mt]`
matrix): the `mt` leg builds real `oneTBB` v2021.13.2
(`uxlfoundation/oneTBB`) from source for `wasm32-emscripten`, then links
`libslic3r` against it with `-pthread -sUSE_PTHREADS=1` (pool size discussed
below). There is no hand-rolled TBB shim on the MT side — the ST-only header
shims in `orca-wasm/wasm/shims/` are what the single-threaded build uses
instead of a real TBB implementation; the MT build's shim directory
variables point at the real, installed oneTBB's own headers
(`orca-wasm/cmake/FindTBB.cmake`). `SLIC3R_WASM_MT`
(`orca-wasm/bridge/CMakeLists.txt`) is the single CMake option that switches
between the two variants; `orc_slice_multi`'s `params.parallel` flag is the
only threading-aware line in the entire bridge — every other bit of real
parallelism happens automatically inside libslic3r once it's linked against
real oneTBB. The `st` leg is unchanged. Both legs are smoke-tested
independently before publishing, and a `compare-outputs` job slices a fixed
mesh set through both and requires matching G-code toolpath structure within
a numeric tolerance (real parallel reductions can legitimately reorder
floating-point summation, so byte-identical output is not required).

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
- The pthread pool itself is spawned from a same-origin `Blob` of the worker
  glue (`slicer.worker.ts`), not the cross-origin engine URL — a raw
  `new Worker(cross-origin-url)` throws `SecurityError`, so the Blob-URL
  pattern this project already uses for module loading (see
  [architecture.md](../architecture.md#blob-url-trick)) is also what makes
  the cross-origin pthread pool possible at all.

## Thread pool sizing

The pthread pool is Emscripten's own: `-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4`
pre-spawns one Web Worker-backed pthread per logical core (plus headroom) at
module load, before any C++ code runs. Pre-spawning is required because a
slicer call does not yield to the JS event loop while it waits for work — a
lazily-created pthread worker (Emscripten's default) never actually
materializes while the calling thread is blocked, so any blocking join/condvar
wait on it hangs forever.

**The pool must cover oneTBB's thread demand**, which is `hardware_concurrency`
(oneTBB eagerly creates ~that many worker pthreads on the first `parallel_for`)
and cannot be reliably bounded any other way — seeding a smaller, fixed-size
pool or capping oneTBB's thread count both deadlock in practice (see "Found
during implementation" below). `-sPTHREAD_POOL_SIZE_STRICT=2` turns any
residual exhaustion into a loud abort rather than a silent hang. Beyond the
thread count, scheduling and work distribution are entirely oneTBB's, not
custom code.

## Verification

`.github/workflows/build-wasm.yml` builds ST and MT as independent matrix
legs (`variant: [st, mt]`, `fail-fast: false`), smoke-tests each
(`orca-wasm/scripts/smoke-test.mjs`) before publishing either artifact, then
a separate `compare-outputs` job runs `orca-wasm/scripts/compare-st-mt.mjs`:
it slices a fixed set of meshes through both engines with identical configs
and requires matching G-code toolpath *structure* (same layer count, same
move count/order) with G0/G1 coordinates matching within a numeric tolerance
— not byte-identical output, since real parallel reductions can legitimately
reorder floating-point summation.

## Performance characteristics (ST vs MT)

Measured in Node (same engine binaries the browser loads) on a
16-logical-core Windows machine, default preset (Bambu P1S / PLA / 0.2 mm /
Arachne / 15% crosshatch), median of 2 warm runs. MT here used the
pool-sized-to-machine configuration described above with TBB free to use
~`hardware_concurrency` threads — the shipped configuration — so these
numbers are representative of what actually ships.

| mesh              | layers | ST     | MT     | speedup (ST/MT) |
|-------------------|-------:|-------:|-------:|----------------:|
| cube 10 mm        |     52 |  313ms |  522ms | 0.60× (MT slower) |
| cube 20 mm        |    102 |  234ms |  308ms | 0.76× |
| cube 40 mm        |    202 |  601ms |  785ms | 0.77× |
| cube 60 mm        |    302 | 1585ms | 1750ms | 0.91× |
| cube 80 mm        |    402 | 2979ms | 2863ms | 1.04× |
| Voron cube (real) |    152 | 4908ms | 3722ms | **1.32× (MT wins)** |

**The win is driven by geometric complexity, not object size.** Simple cubes
barely parallelize — even the 402-layer 80 mm cube is only break-even, because
its per-layer work (a few straight perimeters + sparse infill) is light and the
run is dominated by inherently-serial phases (G-code serialization, etc.) that
oneTBB doesn't touch, so thread-coordination overhead roughly cancels the gain.
The Voron cube — real-world detail that drives the Arachne wall generator hard
— is the CPU-bound case where per-region parallelism pays off (~32% faster).

Practical read: MT's *losses* fall on already-fast slices (sub-second, where a
+200 ms regression is imperceptible) and its *wins* fall on the slow, heavy
slices users actually wait on. So MT is defensible as the default on isolated
hosts — but it is **not** a universal speedup; if per-model engine selection is
ever wanted, gate it on a complexity/expected-time heuristic rather than
assuming MT is always faster. See [the full ST vs MT benchmark
page](../st-mt-benchmark.md) for the complete methodology.

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
  hook the same way. Fixed by passing `(instance, module)` to
  `successCallback`.
- **Found during implementation — MT deadlocked from pthread-pool
  exhaustion; fix required two tries.** Confirmed on real Chrome: the MT
  engine hung 130+ s and never completed on a trivial 10 mm cube (~1–2s on
  ST), near-idle CPU (~1.2 CPU-seconds/5s) — a deadlock. oneTBB created
  ~`hardware_concurrency` worker pthreads on the first `parallel_for`,
  exhausting an 8-slot pool; the on-demand grow-the-pool path can't complete
  while the slicer thread is blocked, so the extra workers hung. The first fix
  attempt (cap TBB to 8 via `tbb::global_control`, pool 16) **passed CI but
  still deadlocked on 16 cores** — the cap starved oneTBB's nested parallelism
  and hung even with a 64-slot pool (verified: fully idle). CI missed it
  because its runners have 2–4 cores, below both the cap and the pool. The
  landed fix removes the cap and instead sizes the pool to the machine (see
  "Thread pool sizing" above). It was **verified** by downloading the
  CI-built artifact and driving it on the 16-core machine: no deadlock, and
  the full ST-vs-MT benchmark completed. **Because low-core CI cannot
  reproduce this class of hang, every future engine change here must be
  re-verified against the CI-built binary on a many-core machine.** The fix
  lives in the engine binary, so enable the Cloudflare COOP/COEP deployment
  only after a merge publishes the rebuilt `*-multithreaded` release and
  `deploy.yml` mirrors it.

## Residual risks

- oneTBB's scheduler on Emscripten pthreads has not been proven under
  irregular/highly unbalanced workloads in-browser — only the fixed
  comparison meshes in CI's `compare-outputs` job.
- Large real-world models remain the most important source of performance
  and stability evidence; G-code equivalence does not prove identical timing
  or memory use.
- The Cloudflare→GitHub-Pages cross-origin load path is exercised by CI's
  same-origin dev-server checks and by the live `compare-outputs` G-code
  check, but the actual cross-origin-under-COEP fetch is only proven on a
  real Cloudflare deploy, not locally.
