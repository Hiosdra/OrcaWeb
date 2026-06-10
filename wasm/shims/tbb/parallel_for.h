#pragma once
#include "blocked_range.h"

namespace tbb {

// Range + functor form
template<typename Range, typename Body>
void parallel_for(const Range& range, const Body& body) {
    body(range);
}
template<typename Range, typename Body, typename Partitioner>
void parallel_for(const Range& range, const Body& body, const Partitioner&) {
    body(range);
}

// Index form
template<typename Index, typename Func>
void parallel_for(Index first, Index last, const Func& f) {
    for (Index i = first; i < last; ++i) f(i);
}
template<typename Index, typename Func, typename Partitioner>
void parallel_for(Index first, Index last, const Func& f, const Partitioner&) {
    parallel_for(first, last, f);
}
template<typename Index, typename Func>
void parallel_for(Index first, Index last, Index step, const Func& f) {
    for (Index i = first; i < last; i += step) f(i);
}

} // namespace tbb
