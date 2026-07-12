#pragma once
#include "blocked_range.h"
#include "partitioner.h"
// Real TBB pulls in this_task_arena transitively via parallel_for.h; mirror that
// so code using tbb::this_task_arena::max_concurrency() compiles with this shim.
#include "task_arena.h"
#include "detail/thread_pool.h"

#include <algorithm>
#include <cstddef>

namespace tbb {
namespace detail_pf {

// See orca-wasm/MT-PLAN.md Phase 1b for why chunk count is capped at the
// pool's live worker count rather than an uncapped grain-implied count, and
// why that cap is a no-op for Thread.cpp's grain=1 startup barrier.
template <typename Range, typename Body>
void dispatch_range(const Range& range, const Body& body) {
    const auto total = range.size();
    if (total == 0) return;

    auto grain = range.grainsize();
    if (grain < 1) grain = 1;

    const int pool_n = detail::ThreadPool::instance().effective_concurrency();
    if (pool_n <= 1) {
        body(range);
        return;
    }

    // Upper bound on useful chunk count implied by the caller's grainsize.
    const auto grain_chunks = (total + grain - 1) / grain;
    const int chunk_count = static_cast<int>(
        std::min<decltype(grain_chunks)>(grain_chunks, static_cast<decltype(grain_chunks)>(pool_n)));

    if (chunk_count <= 1) {
        body(range);
        return;
    }

    const auto b0 = range.begin();
    const auto e0 = range.end();
    const auto full_size = total;

    detail::ThreadPool::instance().run(chunk_count, [&](int idx) {
        // Evenly bisect [b0, e0) into chunk_count contiguous pieces — plain
        // range division, not grain-stepping, once the count is capped (see
        // Phase 1b: this is what makes the 100k-triangle/grain=1 case produce
        // pool_n big chunks instead of one task per triangle).
        //
        // Offsets are computed in full_size's own type (range.size()'s
        // size_type) and added to b0 directly via its natural operator+ —
        // NOT cast to decltype(b0) first. That cast is wrong whenever Value
        // is a random-access iterator rather than an arithmetic type (found
        // by the real Phase 2 CI build: libslic3r's Execution/ExecutionTBB.hpp
        // instantiates parallel_for over tbb::blocked_range<std::vector<...>
        // ::iterator>, e.g. from SLA/SupportTreeBuildsteps.cpp) — an iterator
        // isn't constructible from a raw integer offset, only reachable via
        // `iterator + offset`. Real TBB's own internal range-splitting code
        // never casts the offset to Value either, for the same reason; it
        // just adds it and lets normal operator+ overload resolution handle
        // both arithmetic and iterator Value types.
        const auto off_begin = (full_size * static_cast<decltype(full_size)>(idx)) / static_cast<decltype(full_size)>(chunk_count);
        const auto sub_begin = b0 + off_begin;
        const auto sub_end = (idx + 1 == chunk_count)
            ? e0
            : b0 + (full_size * static_cast<decltype(full_size)>(idx + 1)) / static_cast<decltype(full_size)>(chunk_count);
        Range sub(sub_begin, sub_end, grain);
        body(sub);
    });
}

// blocked_range2d has no .size()/.begin()/.end() of its own (see
// blocked_range.h — it's a pair of independent row/col blocked_range<T>s),
// so it can't go through the generic dispatch_range<Range,Body> above.
// Found by the real Phase 2 CI build failing to compile
// Fill/Lightning/Layer.cpp ("no member named 'size' in
// 'tbb::blocked_range2d<long long>'") — Phase 0's inventory covered the 1D
// blocked_range parallel_for shape but missed this distinct 2D range type.
// Parallelizes over the row dimension only, keeping each chunk's column
// range as the full original width — same chunk-count-capped-at-pool-size
// approach as dispatch_range above, just splitting rows instead of a flat
// [begin,end). Valid because (checked against the real call site) a
// blocked_range2d body is written to independently re-iterate whatever
// sub-rectangle it's handed via range.rows()/range.cols(), so it can't
// depend on how the 2D range happened to get split.
template <typename RowValue, typename ColValue, typename Body>
void dispatch_range2d(const blocked_range2d<RowValue, ColValue>& range, const Body& body) {
    const auto& rows = range.rows();
    const auto& cols = range.cols();
    const auto total = rows.size();
    if (total == 0 || cols.empty()) return;

    auto grain = rows.grainsize();
    if (grain < 1) grain = 1;

    const int pool_n = detail::ThreadPool::instance().effective_concurrency();
    if (pool_n <= 1) {
        body(range);
        return;
    }

    const auto grain_chunks = (total + grain - 1) / grain;
    const int chunk_count = static_cast<int>(
        std::min<decltype(grain_chunks)>(grain_chunks, static_cast<decltype(grain_chunks)>(pool_n)));

    if (chunk_count <= 1) {
        body(range);
        return;
    }

    const auto rb = rows.begin();
    const auto re = rows.end();
    const auto col_grain = cols.grainsize();

    detail::ThreadPool::instance().run(chunk_count, [&](int idx) {
        const auto sub_rb = rb + (total * static_cast<decltype(total)>(idx)) /
            static_cast<decltype(total)>(chunk_count);
        const auto sub_re = (idx + 1 == chunk_count)
            ? re
            : rb + (total * static_cast<decltype(total)>(idx + 1)) /
                  static_cast<decltype(total)>(chunk_count);
        blocked_range2d<RowValue, ColValue> sub(
            sub_rb, sub_re, grain, cols.begin(), cols.end(), col_grain);
        body(sub);
    });
}

} // namespace detail_pf

// Range + functor form
template<typename Range, typename Body>
void parallel_for(const Range& range, const Body& body) {
    detail_pf::dispatch_range(range, body);
}
template<typename Range, typename Body, typename Partitioner>
void parallel_for(const Range& range, const Body& body, const Partitioner&) {
    detail_pf::dispatch_range(range, body);
}

// blocked_range2d overload — more specialized than the generic Range form
// above, so overload resolution picks this one for blocked_range2d
// arguments (standard C++ partial ordering, same mechanism real TBB itself
// uses to provide range-type-specific parallel_for overloads).
template<typename RowValue, typename ColValue, typename Body>
void parallel_for(const blocked_range2d<RowValue, ColValue>& range, const Body& body) {
    detail_pf::dispatch_range2d(range, body);
}
template<typename RowValue, typename ColValue, typename Body, typename Partitioner>
void parallel_for(const blocked_range2d<RowValue, ColValue>& range, const Body& body, const Partitioner&) {
    detail_pf::dispatch_range2d(range, body);
}

// Index form — delegates to the range form so it gets the same chunking.
template<typename Index, typename Func>
void parallel_for(Index first, Index last, const Func& f) {
    if (first >= last) return;
    parallel_for(blocked_range<Index>(first, last), [&f](const blocked_range<Index>& r) {
        for (Index i = r.begin(); i < r.end(); ++i) f(i);
    });
}
template<typename Index, typename Func, typename Partitioner>
void parallel_for(Index first, Index last, const Func& f, const Partitioner&) {
    parallel_for(first, last, f);
}

// Index+step form — MT-PLAN.md Phase 0 found no caller of this overload in
// libslic3r; kept sequential rather than risk miscounting non-multiple-of-step
// chunk boundaries for a path with no test coverage from real usage.
template<typename Index, typename Func>
void parallel_for(Index first, Index last, Index step, const Func& f) {
    for (Index i = first; i < last; i += step) f(i);
}

} // namespace tbb
