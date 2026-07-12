# ADR-007: Sequential TBB Stubs for Single-Threaded WASM

**Status:** Accepted  
**Date:** 2026-06-14

## Context

OrcaSlicer uses Intel TBB (Threading Building Blocks) extensively throughout
`libslic3r` — `parallel_for`, `parallel_reduce`, `parallel_invoke`,
`concurrent_vector`, `task_arena`, and more. TBB is a threading library: it
creates OS threads, uses mutexes, and relies on platform-specific synchronisation
primitives.

WebAssembly without `SharedArrayBuffer` is **single-threaded**. Emscripten does
not ship TBB and cannot emulate real threading. Attempting to link real TBB
against a WASM target is not feasible.

We could not simply remove TBB callsites — they are scattered across hundreds of
files in `libslic3r`, and modifying them in-place would contaminate the submodule
(violating the constraint from ADR-006).

## Decision

Provide a complete set of **drop-in sequential stub headers** in
`orca-wasm/wasm/shims/tbb/` (and `orca-wasm/wasm/shims/oneapi/tbb/`).

These headers are placed on the `BEFORE PUBLIC` include path (see ADR-006 Layer 3),
so the compiler finds them before any system TBB installation. Every TBB API used
by OrcaSlicer is implemented inline as a sequential equivalent:

| Shim header | Sequential implementation |
|-------------|--------------------------|
| `tbb/parallel_for.h` | `for` loop (range or index functor) |
| `tbb/parallel_for_each.h` | `std::for_each` |
| `tbb/parallel_reduce.h` | Sequential iteration + merge call |
| `tbb/parallel_invoke.h` | Call all functors sequentially |
| `tbb/parallel_pipeline.h` | Sequential pipeline (`flow_control`, `filter_t`, `make_filter`) |
| `tbb/task_arena.h` | `max_concurrency()` → 1; `execute()` calls functor directly |
| `tbb/task_group.h` | `run()` calls functor immediately; `wait()` is no-op |
| `tbb/spin_mutex.h` | No-op mutex (single thread, no contention possible) |
| `tbb/partitioner.h` | Empty tag types (`simple_partitioner`, `auto_partitioner`, etc.) |
| `tbb/global_control.h` | No-op |
| `tbb/concurrent_vector.h` | `std::vector` alias |
| `tbb/concurrent_unordered_map.h` | `std::unordered_map` alias |
| `tbb/concurrent_unordered_set.h` | `std::unordered_set` alias |
| `tbb/blocked_range.h` + `blocked_range2d.h` | Lightweight range containers |
| `tbb/version.h` | Version constants |
| `oneapi/tbb/*.h` | Re-exports → `tbb/*.h` |

## Correctness Argument

Sequential execution is **semantically correct** for all of these patterns:

- `parallel_for` / `parallel_for_each` / `parallel_reduce` — the sequential
  fallback is well-defined by the TBB specification; results are identical.
- `concurrent_vector` / `concurrent_unordered_*` — with a single thread there
  is no concurrency, so standard containers are drop-in replacements.
- Mutexes / spin mutexes — no-op in single-threaded context; lock acquisition
  always succeeds immediately.

The only observable difference is **throughput**: algorithms that TBB would
parallelise now run sequentially. In practice, the OrcaSlicer WASM build slices
a typical model in 50–500 ms, which is acceptable.

## Consequences

- **Positive:** Zero changes to OrcaSlicer source — all TBB callsites compile
  unmodified against the stub headers.
- **Positive:** No linker dependency on libtbb.
- **Positive:** Behaviour is deterministic and correct (sequential is a valid
  TBB execution policy).
- **Negative:** Multi-core speedup is lost. On complex models, slicing may be
  slower than on a native multi-threaded desktop build. This is an inherent
  constraint of single-threaded WASM.
- **Future:** If `SharedArrayBuffer` + Atomics become reliably available (requires
  COOP/COEP headers), real TBB or a threading-capable Emscripten build could be
  explored. The stub headers could then be replaced with a real TBB port
  without touching `libslic3r` callsites. Note: COOP/COEP is currently only
  served by the Vite **dev** server (`vite.config.ts`); the production
  deployment on GitHub Pages cannot send custom response headers, so
  `crossOriginIsolated` is `false` in production today. See
  `poc/wasm-threads/` for a working, standalone proof-of-concept (pthreads +
  SharedArrayBuffer, served with COOP/COEP from a plain Node server) showing
  near-linear multi-core speedup once headers are available, as a first step
  toward evaluating this path.
