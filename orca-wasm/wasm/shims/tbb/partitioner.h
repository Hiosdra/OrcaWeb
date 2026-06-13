#pragma once

namespace tbb {

// Partitioner tag types — passed to parallel_for / parallel_reduce.  In the
// sequential shim they carry no behaviour; the parallel_* overloads accept and
// ignore them.
struct simple_partitioner {};
struct auto_partitioner {};
struct static_partitioner {};

class affinity_partitioner {
public:
    affinity_partitioner() = default;
};

} // namespace tbb
