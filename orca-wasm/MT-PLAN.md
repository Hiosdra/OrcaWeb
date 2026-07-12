# WASM multithreading design

This document records the durable design constraints for the pthread-backed
TBB compatibility layer. Implementation history and CI debugging notes belong
in commits and workflow logs.

## Scope

The multithreaded engine keeps OrcaWeb's C bridge API unchanged. OrcaSlicer
continues to call the TBB API it already uses; `shims-mt/` supplies the subset
required by libslic3r and dispatches work through a fixed pthread pool.

The single-threaded engine remains available. Browsers may load the MT artifact
only when `crossOriginIsolated` is true; otherwise the worker loads the ST
artifact. A single WASM binary cannot switch pthread support at runtime.

## Thread pool

- The pool is pre-spawned because a slicer call does not yield to the JavaScript
  event loop while it waits for work.
- Pool size is capped at eight and reports the number of workers actually
  created. Failure to create workers degrades to inline execution.
- Nested dispatch from a pool worker executes inline to avoid self-deadlock.
- Chunk count never exceeds effective pool concurrency.
- Worker exceptions are captured, the completion barrier is always released,
  and the first exception is rethrown on the caller so the bridge can return a
  recoverable slicing error.

## Implemented TBB surface

The MT shim implements the APIs exercised by libslic3r: blocked ranges,
`parallel_for`, `parallel_reduce`, `parallel_for_each`, `parallel_invoke`,
`task_group`, `task_arena`, `global_control`, concurrent map/set/vector, and
spin-based mutex types. `parallel_pipeline` stays sequential because the
current caller is not performance-critical and a partial concurrent pipeline
would add disproportionate scheduling complexity.

## Container guarantees

- `concurrent_vector` serializes growth and supports the indexed-write and
  concurrent-append patterns used by libslic3r.
- `concurrent_unordered_map` returns node-pointer-backed iterators. Element
  pointers remain valid across rehash, matching the iterator stability needed
  by TreeSupport memoization.
- Map and set structural operations are mutex-protected.

## Floating-point behavior

Parallel reductions join chunks in deterministic chunk order. Different chunk
boundaries may still cause insignificant floating-point rounding differences,
so equivalence tests compare parsed G-code semantics with explicit tolerances
instead of requiring byte-identical output.

## Verification

The native shim suite covers:

- startup barriers with zero, one, two, and four workers;
- nested parallelism and pool concurrency limits;
- integer, iterator, and 2D blocked ranges;
- parallel reductions and concurrent container access;
- iterator stability across forced map rehash;
- exception forwarding from `parallel_for` and `task_group`;
- completion and race safety under ThreadSanitizer.

The WASM workflow builds ST and MT artifacts independently, slices synthetic
and real meshes with both, and compares their G-code output. The browser E2E
suite verifies runtime artifact selection and the normal slicing path.

## Residual risks

- Spin locks assume short critical sections; long-held locks can waste a fixed
  browser worker slot.
- The pool has no work stealing, so irregular workloads may scale worse than
  native oneTBB.
- MT requires COOP/COEP headers and therefore cannot run on the existing GitHub
  Pages deployment.
- Large real-world models remain the most important source of performance and
  stability evidence; G-code equivalence does not prove identical timing or
  memory use.
