# PoC: real WASM multithreading (pthreads + SharedArrayBuffer)

Companion to [`mkdocs-docs/adr/adr-007-tbb-stubs.md`](../../mkdocs-docs/adr/adr-007-tbb-stubs.md), which explains
why OrcaWeb's slicer build currently uses sequential stand-ins for Intel TBB
(`orca-wasm/wasm/shims/tbb/*.h`) instead of real parallelism.

This PoC answers the question the ADR leaves open: **does real WASM
multithreading actually work once you serve it from a host that can send
COOP/COEP headers (unlike GitHub Pages)?** Yes — verified below.

## What's here

A minimal Emscripten build, independent of the OrcaSlicer codebase, built
**twice from the same C source** (`src/parallel_demo.c`, the same chunked
`parallel_for`-style reduction shape that `libslic3r` hands to TBB per
layer/object) via `build.sh`:

- **`public/dist-st/`** — no `-pthread`. `pthread_create()` always fails at
  runtime (standard Emscripten behavior without `USE_PTHREADS`), so
  `run_parallel()` falls back to running every chunk synchronously — the same
  graceful degradation `libslic3r`'s TBB stubs give today (ADR-007). Loads on
  any HTTP server, no COOP/COEP required.
- **`public/dist-mt/`** — `-pthread`/`-sUSE_PTHREADS=1`. Real thread
  parallelism via `pthread_create`/`pthread_join`. Requires COOP/COEP to
  instantiate at all (see `server.js`).

Both run from inside a dedicated Worker (`public/worker.js`) — mirroring how
`src/workers/slicer.worker.ts` already hosts the real slicer off the main UI
thread. `worker.js` itself picks which variant to load at runtime based on
`self.crossOriginIsolated` — this is a **working reference implementation**
of the dual-mode loading pattern described in `INTEGRATION-NOTES.md` §3, not
just a description of it: the exact same deployed files serve GitHub Pages
today (falls back to `dist-st/`) and a future COOP/COEP-capable host
(auto-upgrades to `dist-mt/`), with zero server-side branching.

## Results (measured in this environment, headless Chromium, 4 logical cores)

| Wariant | Czas (ms) | Speedup | Wynik |
|---|---|---|---|
| sekwencyjnie (1 wątek) | 10345.2 | 1.00× | 168654811704.6265 |
| równolegle, 2 wątki pthread | 5581.9 | 1.85× | 168654811704.6060 |
| równolegle, 4 wątki pthread | 2619.5 | 3.95× | 168654811704.6187 |

Near-linear scaling with core count, and the results agree across variants
to floating-point summation-order noise — confirming the parallel split is
both correct and faster, not just faster.

**Negative control:** the same build served over plain HTTP (no COOP/COEP,
e.g. `python3 -m http.server`) fails immediately with:

```
Failed to execute 'postMessage' on 'Worker': SharedArrayBuffer transfer requires self.crossOriginIsolated.
```

This is exactly the failure mode a real threaded OrcaSlicer build would hit
on GitHub Pages today, and precisely why ADR-007's stubs are a deliberate,
correct choice for the current host.

## Running it yourself

Requires the Emscripten SDK (matching the project's `3.1.74`, see
`.github/workflows/build-wasm.yml`) on `PATH`:

```bash
# one-time toolchain setup (or reuse an existing emsdk checkout)
git clone https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install 3.1.74 && ./emsdk/emsdk activate 3.1.74
source ./emsdk/emsdk_env.sh

# build both variants + serve
cd poc/wasm-threads
./build.sh
node server.js   # http://localhost:8787
```

Open the URL, wait for the status line to confirm which variant loaded
(`multithreaded` if `crossOriginIsolated: true`, `single-threaded` otherwise),
then click "Uruchom test". Serve the same `public/` directory over plain
HTTP (no COOP/COEP) instead and it falls back to `dist-st/` automatically —
same files, no code change, no broken load.

## Packaging a release

`package.sh <version>` bundles each variant (HTML/JS + that variant's
compiled output + `server.js`) into a standalone, independently-runnable
archive:

```bash
./build.sh
./package.sh v0.1.0
# -> release-artifacts/single-threaded/wasm-threads-poc-v0.1.0-single-threaded.tar.gz
# -> release-artifacts/multithreaded/wasm-threads-poc-v0.1.0-multithreaded.tar.gz
```

`.github/workflows/build-wasm-threads-poc.yml` runs this on `workflow_dispatch`
or a `wasm-threads-poc-v*` tag push and publishes both as separate GitHub
Releases, sharing one patch counter (`wasm-poc-vX.Y.Z[-patchN]` for the
single-threaded build, the same tag with a `-multithreaded` suffix for the
threaded one) — the same tag-generation scheme `build-wasm.yml` already uses
for the real engine's releases, deliberately namespaced `wasm-poc-*` so it
can never collide with the real engine's `wasm-vX.Y.Z[-patchN]` tags. See the
workflow file's header comment for how this would graft onto `build-wasm.yml`
once real pthread-based TBB shims exist for `libslic3r`.

Each packaged archive is independently runnable (`tar xzf … && node
server.js`) and self-contained — download just the multithreaded one to see
real threading directly, or just the single-threaded one to confirm nothing
regresses. To exercise the *combined* dual-mode auto-switch from a single
deployment (the real production goal), unpack both archives' `public/`
directories on top of each other so `dist-st/` and `dist-mt/` sit side by
side, as `build.sh` produces them locally.

## What this does *not* prove

This is a standalone, ~100-line C demo, not a threaded rebuild of
OrcaSlicer. It shows the infrastructure and toolchain path work end to end;
it does **not** replace the work described as follow-up in ADR-007:

1. Rebuilding `libslic3r`/OrcaSlicer's Emscripten target with `-pthread`
   and a threading-capable TBB substitute instead of the sequential shims
   in `orca-wasm/wasm/shims/tbb/*.h`.
2. Deploying OrcaWeb somewhere that can send COOP/COEP in production —
   GitHub Pages can't; Cloudflare Pages, Netlify, or a small
   Node/Express host (with a `_headers` file or equivalent) can. A
   service-worker header-injection shim (`coi-serviceworker`) is a
   fallback, but conflicts with OrcaWeb's existing PWA service worker,
   which is already disabled in dev for this reason
   (`vite.config.ts:64-67`).
3. Verifying the full OrcaSlicer WASM binary size/startup cost increase
   that comes with pthread support (larger runtime, worker-pool warmup).

## Further reading

See [`INTEGRATION-NOTES.md`](./INTEGRATION-NOTES.md) for:

- An evaluation of two existing third-party TBB-for-WASM ports
  (`hpcwasm/wasmtbb`, `discere-os/oneTBB.wasm`) and why neither is a
  ready drop-in replacement today.
- A concrete assessment of how much `orca-wasm/bridge/slicer.cpp`'s
  exported API would need to change to support real threading (short
  answer: the function signatures don't change at all — one line
  flips from `false` to `true`).
- Why a single WASM binary can't auto-switch between multi-threaded
  and single-threaded execution at runtime, and the two-artifact,
  feature-detected loading pattern that achieves the same practical
  result (multi-threaded when COOP/COEP headers are present, today's
  behavior unchanged when they aren't) — now a working reference
  implementation in this PoC (`build.sh` + `worker.js`), not just a
  description, plus a matching dual-artifact release workflow.
