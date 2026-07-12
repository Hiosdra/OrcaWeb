#!/usr/bin/env bash
# Builds both PoC variants from the same C source. Requires the emsdk on
# PATH (see README.md).
#
# - dist-st/: no -pthread — pthread_create() always fails at runtime (the
#   standard Emscripten stub behavior without USE_PTHREADS), so run_parallel()
#   falls back to run_sequential() for every chunk. Loads on any HTTP server,
#   no COOP/COEP required. Mirrors OrcaWeb's current production build.
# - dist-mt/: -pthread/-sUSE_PTHREADS=1 — real thread parallelism. Requires
#   COOP/COEP headers (see server.js) to instantiate at all.
#
# Both are exposed by the SAME public/worker.js, which picks one at runtime
# via self.crossOriginIsolated — see INTEGRATION-NOTES.md §3.
set -euo pipefail
cd "$(dirname "$0")"

COMMON_FLAGS=(
  -O3
  -sALLOW_MEMORY_GROWTH=1
  -sEXPORTED_FUNCTIONS=_run_sequential,_run_parallel,_get_hardware_concurrency,_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap
  -sMODULARIZE=1
  -sEXPORT_NAME=ParallelDemoModule
  -sENVIRONMENT=worker
)

echo "==> Building single-threaded variant (dist-st/)"
mkdir -p public/dist-st
emcc src/parallel_demo.c "${COMMON_FLAGS[@]}" -o public/dist-st/parallel_demo.js

echo "==> Building multi-threaded variant (dist-mt/)"
mkdir -p public/dist-mt
emcc src/parallel_demo.c "${COMMON_FLAGS[@]}" \
  -pthread \
  -sUSE_PTHREADS=1 \
  -sPTHREAD_POOL_SIZE=8 \
  -o public/dist-mt/parallel_demo.js

echo "Built public/dist-st/parallel_demo.{js,wasm} + public/dist-mt/parallel_demo.{js,wasm}"
