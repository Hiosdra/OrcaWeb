#pragma once
#include "blocked_range.h"
#include "partitioner.h"
#include "detail/thread_pool.h"

#include <algorithm>
#include <vector>

namespace tbb {

// MT-PLAN.md Phase 0: the only real caller (Execution/ExecutionTBB.hpp) uses
// the functional form exclusively — the split-constructible-Body form
// (Body::join()) has zero callers, so it stays the sequential single-call
// shim below rather than earning a real parallel implementation.

// Body-form: body(range) accumulates into body itself. No real caller —
// kept sequential (see above).
template<typename Range, typename Body>
void parallel_reduce(const Range& range, Body& body) {
    body(range);
}
template<typename Range, typename Body, typename Partitioner>
void parallel_reduce(const Range& range, Body& body, const Partitioner&) {
    body(range);
}

// Functional form — the one real call site. Chunk exactly as parallel_for
// does (same cap-at-pool-size, evenly-bisect strategy — see MT-PLAN.md
// Phase 1b), run body(subrange, identity) per chunk on the pool, then fold
// with reduction() in chunk order (left to right) once all chunks complete.
// In-order folding keeps parallel_deterministic_reduce actually
// deterministic; plain parallel_reduce shares this implementation
// (stricter than TBB requires — fine).
template<typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_reduce(const Range& range, const Value& identity,
                      const RealBody& body, const Reduction& reduction) {
    const auto total = range.size();
    if (total == 0) return identity;

    auto grain = range.grainsize();
    if (grain < 1) grain = 1;

    const int pool_n = detail::ThreadPool::instance().effective_concurrency();
    const auto grain_chunks = (total + grain - 1) / grain;
    const int chunk_count = (pool_n <= 1)
        ? 1
        : static_cast<int>(std::min<decltype(grain_chunks)>(
              grain_chunks, static_cast<decltype(grain_chunks)>(pool_n)));

    if (chunk_count <= 1) {
        return body(range, identity);
    }

    const auto b0 = range.begin();
    const auto e0 = range.end();
    const auto full_size = total;

    std::vector<Value> partials(static_cast<size_t>(chunk_count), identity);
    detail::ThreadPool::instance().run(chunk_count, [&](int idx) {
        // Offsets computed in full_size's own type and added to b0 directly
        // via its natural operator+ — NOT cast to decltype(b0) first. Same
        // bug (and same fix) as parallel_for.h's dispatch_range: that cast
        // doesn't compile when Value is a random-access iterator rather than
        // an arithmetic type (found here by the real Phase 2 CI build via
        // Execution/ExecutionTBB.hpp's reduce(), instantiated over
        // std::vector<indexed_triangle_set>::iterator from
        // SlicesToTriangleMesh.cpp) — an iterator isn't constructible from a
        // raw integer offset, only reachable via `iterator + offset`.
        const auto off_begin = (full_size * static_cast<decltype(full_size)>(idx)) / static_cast<decltype(full_size)>(chunk_count);
        const auto sub_begin = b0 + off_begin;
        const auto sub_end = (idx + 1 == chunk_count)
            ? e0
            : b0 + (full_size * static_cast<decltype(full_size)>(idx + 1)) / static_cast<decltype(full_size)>(chunk_count);
        Range sub(sub_begin, sub_end, grain);
        partials[static_cast<size_t>(idx)] = body(sub, identity);
    });

    Value acc = identity;
    for (int i = 0; i < chunk_count; ++i) {
        acc = reduction(acc, partials[static_cast<size_t>(i)]);
    }
    return acc;
}
template<typename Range, typename Value, typename RealBody, typename Reduction,
         typename Partitioner>
Value parallel_reduce(const Range& range, const Value& identity,
                      const RealBody& body, const Reduction& reduction,
                      const Partitioner&) {
    return parallel_reduce(range, identity, body, reduction);
}

// parallel_deterministic_reduce — shares the real functional-form
// implementation above (in-order fold), which is already deterministic.
template<typename Range, typename Body>
void parallel_deterministic_reduce(const Range& range, Body& body) {
    body(range);
}
template<typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_deterministic_reduce(const Range& range, const Value& identity,
                                    const RealBody& body, const Reduction& reduction) {
    return parallel_reduce(range, identity, body, reduction);
}

// parallel_scan — no caller in libslic3r (MT-PLAN.md Phase 0 inventory);
// kept sequential.
template<typename Range, typename Body>
void parallel_scan(const Range& range, Body& body) {
    body(range, /*is_final=*/true);
}

} // namespace tbb
