# Integration notes: third-party TBB/WASM ports, bridge API impact, dual-mode loading

Follow-up to the PoC in this directory and to `mkdocs-docs/adr/adr-007-tbb-stubs.md`,
answering three concrete questions raised in review:

1. Are there existing TBB-for-WASM projects worth building on instead of a custom port?
2. How much would `orca-wasm/bridge/slicer.cpp`'s exported API have to change to support
   real threading?
3. Can one build of the engine serve both a multi-threaded path (when COOP/COEP headers
   are present) and a single-threaded path (when they aren't, e.g. today's GitHub Pages
   demo), switching automatically at runtime?

## 1. Third-party TBB/WASM ports

### [hpcwasm/wasmtbb](https://github.com/hpcwasm/wasmtbb)

A port of classic Intel TBB **2019 Update 5/6** to `wasm32-emscripten`.

- Very early stage: ~6 stars, ~20 commits, 0 releases, 1 open issue.
- The public README doesn't document Emscripten flags, confirm real pthread support, or
  enumerate which primitives (`parallel_for`, `parallel_reduce`, `task_arena`, …) are
  actually implemented for the WASM target — that detail is apparently only in
  `README_WASM.md`, which wasn't practical to fully verify from outside the repo.
- TBB 2019 is the legacy line; Intel moved development to **oneTBB** around 2021, so this
  is building on an already-superseded base.
- **Verdict:** interesting as prior art on the porting technique, but too immature
  (no releases, unclear primitive coverage, stale upstream base) to depend on directly.
  Would need a fork, an audit of every primitive OrcaSlicer actually uses, and ongoing
  maintenance burden we'd own alone.

### [discere-os/oneTBB.wasm](https://github.com/discere-os/oneTBB.wasm)

A fork of the actively-maintained **oneTBB** (`uxlfoundation/oneTBB`) specifically
targeting WASM.

- Explicitly addresses the exact pain points this PoC hit while building
  `poc/wasm-threads/`: "nested Web Worker issues" and a "serial execution problem" in
  the naive port — this PoC worked around the equivalent issue with
  `mainScriptUrlOrBlob` (see `public/worker.js`) to get nested pthread-worker spawning
  to resolve correctly.
- Confirms the same hard requirement this PoC demonstrates: **"Threading requires
  SharedArrayBuffer (secure context + COOP/COEP headers)."** No project gets around that
  constraint — it's a browser-level restriction, not an implementation gap.
- Reports **3.2–3.5× speedup** benchmarks — closely matching this PoC's measured
  3.86× on 4 threads, which is a useful independent cross-check that our numbers are in
  the right ballpark.
- However: 0 stars, no releases, single maintainer, and the build/integration surface is
  **Deno/TypeScript-oriented** (`deno task build:wasm|:side|:main|:threads`, producing
  SIDE_MODULE/MAIN_MODULE WASM artifacts with a TS API) rather than a CMake-friendly C++
  library meant to be `#include`d and linked into another project's build. OrcaSlicer's
  `libslic3r` uses TBB via inline C++ template headers
  (`#include <tbb/parallel_for.h>` etc.) compiled directly into the same translation
  units — not via calls into a separately-built WASM module.
- Integrating it would mean either (a) extracting the underlying patched oneTBB C++
  source and building it as a static library inside our own CMake/Emscripten pipeline
  (plausible in principle since it's a real oneTBB fork, but undocumented and would
  require exploring their source tree firsthand), or (b) treating it as a separate WASM
  module called across a module boundary — impractical for `parallel_for` callsites that
  need to run inline in hot loops throughout `libslic3r`.
- **Verdict:** the most useful reference point of the two — it validates that our
  approach and measurements are sound, and its handling of nested-worker/thread-pool
  warm-up is worth studying — but it is not a drop-in replacement today. A from-scratch
  threaded shim (as ADR-007 already anticipates), possibly informed by how this project
  solves thread-pool warm-up, remains the more realistic path.

## 2. Bridge API impact

Read the full bridge (`orca-wasm/bridge/slicer.cpp`) and loader
(`src/lib/wasm-loader.ts`) to answer this concretely rather than speculatively.

**Finding: the exported C function signatures would not change at all.**

`orc_init`, `orc_slice`, `orc_slice_multi`, `orc_obj_to_stl`, `orc_cad_to_stl`,
`orc_free`, `orc_decode_exception` are all synchronous, blocking calls operating on
in/out buffers. Threading happens deep inside `print.process()` via TBB calls in
`libslic3r` — the bridge has no visibility into it and doesn't need any.

The **only** line in the entire bridge that is even aware of threading is
`orca-wasm/bridge/slicer.cpp:453`, inside `orc_slice_multi`'s auto-arrange step:

```cpp
params.parallel = false; // WASM is single-threaded
```

That would flip to `true` (or be made conditional on the build variant) — a one-line
change.

On the JS side, `sliceStl` / `objToStl` / `sliceMultiStl` / `cadToStl` in
`src/lib/wasm-loader.ts` all call the same `module._orc_*` exports with the same
arguments regardless of threading — no changes needed there either.

**What actually has to change** is the build and loading layer, not the API:

- **Build**: a second build target producing `-pthread -sUSE_PTHREADS=1` output linked
  against a real threaded TBB/oneTBB-compatible shim, alongside the existing
  single-threaded build. Because ADR-007's stub headers are swapped in purely via
  include-path precedence (`orca-wasm/wasm/shims/tbb/`, see ADR-006 Layer 3), this is a
  second CI job/CMake flag combination — **zero changes to `libslic3r` source**.
- **Loader**: `wasm-loader.ts:7-47` currently always fetches `slicer.wasm`/`slicer.js` by
  fixed name. It would need to feature-detect and choose between two prebuilt artifact
  sets (see §3).

## 3. Can one engine auto-switch between MT and ST at runtime?

**Not as a single WASM binary — but yes, with two build artifacts chosen at runtime.**
This is a real constraint worth spelling out precisely, since it shapes the design:

Compiling with `-pthread`/`-sUSE_PTHREADS=1` makes Emscripten declare the module's
linear memory as `shared` (a `WebAssembly.Memory({shared: true, ...})`) — a property
baked into the compiled module itself, not decided at load time. Instantiating a module
that declares shared memory **requires `SharedArrayBuffer` to already be available**. If
the page isn't cross-origin-isolated, instantiation throws immediately — there's no
graceful degradation to single-threaded execution within that same `.wasm` file. This
PoC's own negative control demonstrates the adjacent failure mode: without COOP/COEP,
the page fails outright (`SharedArrayBuffer transfer requires self.crossOriginIsolated`)
rather than degrading gracefully.

The pattern used industry-wide for exactly this situation (ffmpeg.wasm, Squoosh, and
others all do this) is: **build twice from the same source, pick the artifact at
runtime.** Concretely, for OrcaWeb:

1. Headers present (your eventual production host) → `wasm-loader.ts` detects
   `self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'`, fetches
   `slicer-mt.{js,wasm}` (built with `-pthread` + real TBB/oneTBB-shim), runs
   multi-threaded.
2. Headers absent (today's GitHub Pages demo) → same detection fails, falls back to
   fetching today's `slicer.{js,wasm}` (the existing sequential-shim build), unchanged
   behavior.

Since GitHub Pages is confirmed to be a temporary demo deployment and the eventual host
will control its own headers, this two-artifact approach means the **same source tree**
serves both today's demo and the future threaded deployment without contradicting
ADR-007 — it's additive (one more build target + a runtime `crossOriginIsolated` check
in the loader), not a replacement of the existing single-threaded path.
