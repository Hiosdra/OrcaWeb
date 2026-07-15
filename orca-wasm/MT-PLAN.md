# WASM multithreading design

This document records the durable design constraints for the multithreaded
(MT) engine variant. Implementation history and CI debugging notes belong in
commits and workflow logs.

## Scope

The multithreaded engine keeps OrcaWeb's C bridge API unchanged. OrcaSlicer
continues to call the TBB API it already uses; the MT build links against
**real oneTBB** (`uxlfoundation/oneTBB` v2021.13.2, built from source for
`wasm32-emscripten` in CI — see `.github/workflows/build-wasm.yml`'s
"Build official oneTBB for WASM (mt)" step), compiled with `-pthread` and
Emscripten's `-sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=8`. There is no hand-rolled
TBB shim on the MT side — the ST-only header shims in `orca-wasm/wasm/shims/`
are what the single-threaded build uses instead of a real TBB implementation;
the MT build's `TBB_SHIM_DIR`/`ORCA_WEB_SHIM_DIR` point at the real,
installed oneTBB's own headers (`orca-wasm/cmake/FindTBB.cmake`), not at any
project-local shim directory.

The single-threaded (ST) engine remains available and is the only variant
GitHub Pages (the primary deployment) ever serves — a single Emscripten WASM
binary cannot switch pthread support at runtime, and GitHub Pages cannot send
the response headers MT needs (see Deployment below). `SLIC3R_WASM_MT`
(`orca-wasm/bridge/CMakeLists.txt`) is the single CMake option that switches
between the two; `orca-wasm/bridge/slicer.cpp`'s `orc_slice_multi` has the
only threading-aware line in the entire bridge (`params.parallel`) — every
other bit of real parallelism happens automatically inside libslic3r once
it's linked against real oneTBB.

## Thread pool

The pthread pool is Emscripten's own: `-sPTHREAD_POOL_SIZE=navigator.hardware
Concurrency+4` pre-spawns one Web Worker-backed pthread per logical core (plus
headroom) at module load, before any C++ code runs. Pre-spawning is required
because a slicer call does not yield to the JS event loop while it waits for
work — a lazily-created pthread worker (Emscripten's default) never actually
materializes while the calling thread is blocked, so any blocking join/condvar
wait on it hangs forever (see `orca-wasm/wasm/CMakeLists.txt`'s
`PTHREAD_POOL_SIZE` comment).

**The pool must cover oneTBB's thread demand**, which is `hardware_concurrency`
(oneTBB eagerly creates ~that many worker pthreads on the first `parallel_for`)
and cannot be reliably bounded any other way — see "Fixed" below for the two
dead ends (an 8-slot pool, and capping TBB) that both deadlocked before landing
on "size the pool to the machine." `-sPTHREAD_POOL_SIZE_STRICT=2` turns any
residual exhaustion into a loud abort rather than a silent hang. Beyond the
thread count, scheduling and work distribution are entirely oneTBB's, not
custom code.

## Deployment: Cloudflare (COOP/COEP) + GitHub Pages (ST-only)

MT requires `SharedArrayBuffer`, which requires the page to be
`crossOriginIsolated` — both `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` response headers. GitHub Pages
cannot send custom headers at all, so it always serves the ST engine
(`slicer.js`/`slicer.wasm`) and never MT.

The Cloudflare mirror sends both headers via `public/_headers`, so it's the
only host where `self.crossOriginIsolated` is ever true. `deploy.yml` mirrors
`slicer-mt.js`/`slicer-mt.wasm` onto GitHub Pages alongside the ST engine
(best-effort — a missing MT release never fails the deploy); Cloudflare
itself cannot host either engine binary directly (both are ~36 MB, over
Workers/Pages' 25 MiB per-asset limit — see `scripts/cf-build.mjs`), so the
Cloudflare build points `VITE_WASM_BASE_URL` at the GitHub Pages copies and
loads them cross-origin. That only works because GitHub Pages serves them
with `Access-Control-Allow-Origin: *` (verified live), which satisfies COEP
`require-corp` for a CORS-mode fetch — plain GitHub **Releases** assets send
neither CORS nor CORP (also verified live: a redirect through a signed,
expiring Azure Blob URL with no `Access-Control-Allow-Origin`), so they
cannot be read cross-origin directly and are never fetched by the browser at
runtime.

At runtime, `src/workers/slicer.worker.ts` checks `crossOriginIsolated`, then
probes for `slicer-mt.js` on the resolved WASM base URL before committing to
it, falling back to the always-present ST engine on any failure (missing
file, network error, or a non-JS response like an SPA-fallback HTML page).

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

## Known-fixed bug: instantiateWasm must pass both instance and module

The bridge's custom `instantiateWasm` hook (`src/workers/slicer.worker.ts`,
used so `WebAssembly.compileStreaming` can overlap download and compilation)
originally called `successCallback(instance)` with only the instantiated
`WebAssembly.Instance`. Emscripten's glue calls this hook as
`Module["instantiateWasm"](info, receiveInstance)` and
`receiveInstance(instance, module)` stores the second argument as its
internal `wasmModule` — which pthread worker spawning (MT builds only) reads
to hand the compiled module to every new pthread worker. Omitting it left
`wasmModule` `undefined`, and every spawned pthread worker crashed
immediately with `Cannot read properties of undefined (reading '...')`,
making the MT engine 100% non-functional in the browser despite compiling
cleanly and passing the Node-level smoke test (which does not exercise this
custom hook the same way — exactly the class of bug ADR-010 exists to catch,
just one layer deeper). Fixed by passing `(instance, module)` to
`successCallback`.

## Fixed bug: MT deadlocked from pthread-pool exhaustion

**Symptom (confirmed on real, unsandboxed Chrome — Windows, 16 real cores):**
slicing a trivial 10 mm test cube took 130+ seconds and never completed on
the MT engine, versus ~1–2 seconds on ST for the identical model. CPU
sampling during the hang ruled out "just slow": across a 5-second window ~1
minute into the stuck slice, every Chrome process combined consumed only ~1.2
CPU-seconds (`Get-Process chrome | Select CPU`, sampled twice 5s apart,
diffed) — roughly a quarter of one core. The browser was near-idle while the
UI said "Slicing…", i.e. threads asleep in `Atomics.wait`, not computing — a
deadlock, not slow computation.

**Root cause:** oneTBB sizes its default arena to `hardware_concurrency` (~15
workers on a 16-logical-core machine) and eagerly `pthread_create`s them on
the first `parallel_for`. The Emscripten pthread pool was only 8 slots, so
the 9th+ creation hit the glue's on-demand grow-the-pool path
(`PThread.getNewWorker` → `allocateUnusedWorker` + `loadWasmModuleToWorker`),
which spawns a brand-new Web Worker and streams the module into it
**asynchronously** — completing only once the requesting thread returns to the
JS event loop. But the slicer thread is a dedicated Web Worker blocked
synchronously inside `Print::process()` and never yields, so those extra
workers hung half-initialized and every TBB barrier/join waiting on them
deadlocked.

**Verified** by patching the local engine glue to pre-spawn 24 workers instead
of 8: with a pool larger than TBB's demand the on-demand path is never taken,
and the same cube then sliced in a few seconds — pinning the cause to pool
exhaustion specifically, not a generic TBB-on-Emscripten bug.

### Dead end: capping oneTBB with `global_control` (do not reintroduce)

The first fix attempt kept the pool at 16 and instead capped oneTBB to
`min(hardware_concurrency, 8)` threads via a
`tbb::global_control(max_allowed_parallelism, …)` static in `slicer.cpp`, on
the theory that a smaller, machine-independent thread demand would always fit
the pool. **It made things worse.** The CI-built engine with that cap was
downloaded and tested on the 16-core machine and *still* deadlocked — and
crucially it deadlocked even with the pool bumped to 64 (verified: node
consumed 0.00 CPU-seconds over a 5s window, fully idle). Since 64 slots
dwarfs any thread demand, the hang could not be pool exhaustion; the
`global_control` cap itself starves oneTBB's (nested) parallelism — libslic3r
has parallel regions that block waiting on work that needs more than the
capped thread count to progress. CI never caught it because GitHub runners
have 2–4 cores, so TBB's demand there was already under the cap and under the
pool. Lesson: **do not cap oneTBB's thread count**; give it the threads it
wants and make the pool cover them.

### Fix: size the pool to the machine, no TBB cap

`orca-wasm/wasm/CMakeLists.txt` sets
`-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency+4` (evaluated at load in
web/worker/node 22) so the pool always covers oneTBB's `hardware_concurrency`
demand plus headroom, on any machine, with no cap. This is the same regime the
pool-bump reproduction above already proved slices correctly (uncapped TBB,
pool ≥ demand). `-sPTHREAD_POOL_SIZE_STRICT=2` stays as a safety net. The
`global_control` cap and its includes were removed from `slicer.cpp`.

**Verified.** Because CI runners have too few cores to reproduce the hang, the
CI-built `slicer-mt.*` artifact was downloaded and driven on the 16-core
machine: it sliced a 20 mm cube in 632 ms (the same engine config previously
hung forever) and ran the full ST-vs-MT benchmark below through every size
with no deadlock. The pool expression compiled correctly
(`pthreadPoolSize=navigator.hardwareConcurrency+4` in the emitted glue).

**Still gated on publishing.** The fix lives in the engine binary. On a PR the
build only uploads an artifact; a merge to master publishes a new
`*-multithreaded` release, which `deploy.yml` then mirrors. Enable the
Cloudflare COOP/COEP deployment only after that published engine is live — and
re-run the many-core check against any *future* engine change here, since
low-core CI still can't catch a regression of this class on its own.

## Performance characteristics (ST vs MT)

Measured in Node (same engine binaries the browser loads) on a 16-logical-core
Windows machine, default preset (Bambu P1S / PLA / 0.2 mm / Arachne / 15 %
crosshatch), median of 2 warm runs. MT here used the pool-bumped local glue
with TBB free to use ~`hardware_concurrency` threads — which is exactly the
shipped configuration (the fix does *not* cap TBB), so these numbers are
representative of the shipped engine.

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
— is the CPU-bound case where per-region parallelism pays off (~32 % faster).

Practical read: MT's *losses* fall on already-fast slices (sub-second, where a
+200 ms regression is imperceptible) and its *wins* fall on the slow, heavy
slices users actually wait on (−1.2 s on the Voron cube). So MT is defensible
as the default on isolated hosts — but it is **not** a universal speedup, and
if per-model selection is ever wanted, gate it on a complexity/expected-time
heuristic rather than assuming MT is always faster.

## Residual risks

- The pool/cap fix is verified by the pool-bump reproduction above, but the
  exact shipped combination (`global_control` cap + 16-slot pool, built by
  CI) can only be end-to-end verified against a freshly rebuilt engine — do
  that before enabling the Cloudflare path.
- oneTBB's scheduler on Emscripten pthreads has not been proven under
  irregular/highly unbalanced workloads in-browser — only the fixed
  comparison meshes in CI's `compare-outputs` job.
- Large real-world models remain the most important source of performance
  and stability evidence; G-code equivalence does not prove identical timing
  or memory use.
- The Cloudflare→GitHub-Pages cross-origin load path is exercised by CI's
  same-origin dev-server checks and by the live `compare-outputs` G-code
  check, but the actual cross-origin-under-COEP fetch is only proven on a
  real Cloudflare deploy, not locally. Note the pthread pool is spawned from
  a same-origin `Blob` of the glue (`slicer.worker.ts`), not the cross-origin
  engine URL — a classic `new Worker(cross-origin-url)` throws SecurityError,
  so the raw-URL form (used through an earlier revision) would have failed on
  Cloudflare regardless of headers. The Blob form is the standard cross-origin
  worker pattern and is verified same-origin; the cross-origin case still
  needs a real CF deploy to confirm end-to-end.
