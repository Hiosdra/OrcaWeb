#pragma once
#include "blocked_range.h"
#include "partitioner.h"

namespace tbb {

// Body-form: body(range) accumulates into body itself.
template<typename Range, typename Body>
void parallel_reduce(const Range& range, Body& body) {
    body(range);
}
template<typename Range, typename Body, typename Partitioner>
void parallel_reduce(const Range& range, Body& body, const Partitioner&) {
    body(range);
}

// Functional form: returns reduce(body(range, identity)).
template<typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_reduce(const Range& range, const Value& identity,
                      const RealBody& body, const Reduction&) {
    return body(range, identity);
}
template<typename Range, typename Value, typename RealBody, typename Reduction,
         typename Partitioner>
Value parallel_reduce(const Range& range, const Value& identity,
                      const RealBody& body, const Reduction& reduction,
                      const Partitioner&) {
    return parallel_reduce(range, identity, body, reduction);
}

// parallel_deterministic_reduce — same sequential behaviour
template<typename Range, typename Body>
void parallel_deterministic_reduce(const Range& range, Body& body) {
    body(range);
}
template<typename Range, typename Value, typename RealBody, typename Reduction>
Value parallel_deterministic_reduce(const Range& range, const Value& identity,
                                    const RealBody& body, const Reduction&) {
    return body(range, identity);
}

// parallel_scan (inclusive / exclusive)
template<typename Range, typename Body>
void parallel_scan(const Range& range, Body& body) {
    body(range, /*is_final=*/true);
}

} // namespace tbb
