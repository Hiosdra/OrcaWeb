// Host-side unit tests for shims-mt/, compiled directly with a native
// compiler (not Emscripten) for fast iteration and ThreadSanitizer coverage.
// See orca-wasm/MT-PLAN.md Phase 1 acceptance criteria.
//
// Build & run (from repo root):
//   g++ -std=c++17 -pthread -fsanitize=thread -g -O1 \
//     -I orca-wasm/wasm/shims-mt \
//     orca-wasm/wasm/shims-mt/test/test_shims_mt.cpp -o /tmp/test_shims_mt
//   /tmp/test_shims_mt
//
// Every TEST() must both assert correctness AND run clean under TSan (no
// data race reports) — a test that "passes" its asserts but races is not
// actually passing.
#include <tbb/tbb.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <numeric>
#include <stdexcept>
#include <thread>
#include <unordered_set>
#include <vector>

static int g_failures = 0;
#define CHECK(cond) \
    do { \
        if (!(cond)) { \
            std::fprintf(stderr, "  CHECK FAILED: %s (%s:%d)\n", #cond, __FILE__, __LINE__); \
            ++g_failures; \
        } \
    } while (0)

#define TEST(name) \
    static void name(); \
    struct name##_runner { \
        name##_runner() { \
            std::fprintf(stderr, "[ RUN ] %s\n", #name); \
            name(); \
            std::fprintf(stderr, "[ DONE] %s\n", #name); \
        } \
    } name##_runner_instance; \
    static void name()

// ── The named acceptance test from MT-PLAN.md Phase 1a: reproduce
// Thread.cpp's name_tbb_thread_pool_threads_set_locale() barrier exactly.
// If this hangs, the pool is too small or dispatch throttles below N. ──
TEST(barrier_all_n_tasks_concurrent) {
    const size_t nthreads = static_cast<size_t>(tbb::this_task_arena::max_concurrency());
    CHECK(nthreads >= 1);

    std::atomic<size_t> arrived{0};
    std::mutex m;
    std::condition_variable cv;
    std::vector<int> seen_indices(nthreads, 0);

    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);

    tbb::parallel_for(
        tbb::blocked_range<size_t>(0, nthreads, 1),
        [&](const tbb::blocked_range<size_t>& range) {
            CHECK(range.begin() + 1 == range.end());
            seen_indices[range.begin()] = 1;
            if (arrived.fetch_add(1, std::memory_order_acq_rel) + 1 == nthreads) {
                std::lock_guard<std::mutex> lk(m);
                cv.notify_all();
            } else {
                std::unique_lock<std::mutex> lk(m);
                bool ok = cv.wait_until(lk, deadline, [&] {
                    return arrived.load(std::memory_order_acquire) == nthreads;
                });
                CHECK(ok); // false means we timed out — this is the deadlock this test exists to catch
            }
        });

    for (size_t i = 0; i < nthreads; ++i) CHECK(seen_indices[i] == 1);
    std::fprintf(stderr, "  nthreads=%zu\n", nthreads);
}

TEST(parallel_for_covers_every_index_exactly_once) {
    const size_t n = 100000;
    std::vector<std::atomic<int>> hits(n);
    for (auto& h : hits) h = 0;

    tbb::parallel_for(tbb::blocked_range<size_t>(0, n), [&](const tbb::blocked_range<size_t>& r) {
        for (size_t i = r.begin(); i < r.end(); ++i) hits[i].fetch_add(1, std::memory_order_relaxed);
    });

    for (size_t i = 0; i < n; ++i) CHECK(hits[i].load() == 1);
}

// Reproduces the real call-site shape found by the Phase 2 CI build failure
// (Execution/ExecutionTBB.hpp's ccr::for_each, used by
// SLA/SupportTreeBuildsteps.cpp: tbb::blocked_range<std::vector<T>::iterator>
// instead of an arithmetic Value type, body does a range-based `for (auto&
// el : range)`) — verifies dispatch_range's chunk-splitting works when Value
// is an iterator, not just an arithmetic type (that distinction is exactly
// what broke: casting a raw integer offset to an iterator type doesn't
// compile, only `iterator + offset` does).
TEST(parallel_for_blocked_range_over_vector_iterator) {
    const size_t n = 100000;
    std::vector<unsigned> data(n);
    for (size_t i = 0; i < n; ++i) data[i] = static_cast<unsigned>(i);
    std::vector<std::atomic<int>> hits(n);
    for (auto& h : hits) h = 0;

    tbb::parallel_for(tbb::blocked_range<std::vector<unsigned>::iterator>(data.begin(), data.end()),
        [&](const tbb::blocked_range<std::vector<unsigned>::iterator>& range) {
            for (auto& el : range) hits[el].fetch_add(1, std::memory_order_relaxed);
        });

    for (size_t i = 0; i < n; ++i) CHECK(hits[i].load() == 1);
}

// Reproduces the real call-site shape found by the Phase 2 CI build failure
// (Fill/Lightning/Layer.cpp: tbb::parallel_for over a tbb::blocked_range2d,
// body iterates range.rows()/range.cols() as a nested loop) — verifies every
// (row, col) cell is visited exactly once under the row-only chunk split.
TEST(parallel_for_blocked_range2d_covers_every_cell_exactly_once) {
    const int rows = 500, cols = 37;
    std::vector<std::atomic<int>> hits(static_cast<size_t>(rows) * cols);
    for (auto& h : hits) h = 0;

    tbb::parallel_for(tbb::blocked_range2d<int>(0, rows, 0, cols),
        [&](const tbb::blocked_range2d<int>& r) {
            for (int y = r.rows().begin(); y < r.rows().end(); ++y)
                for (int x = r.cols().begin(); x < r.cols().end(); ++x)
                    hits[static_cast<size_t>(y) * cols + x].fetch_add(1, std::memory_order_relaxed);
        });

    for (auto& h : hits) CHECK(h.load() == 1);
}

TEST(parallel_for_index_form) {
    std::atomic<long> sum{0};
    tbb::parallel_for(size_t(0), size_t(10000), [&](size_t i) {
        sum.fetch_add(static_cast<long>(i), std::memory_order_relaxed);
    });
    CHECK(sum.load() == 10000L * 9999L / 2L);
}

TEST(nested_parallel_for_does_not_deadlock) {
    const int outer_n = 8;
    std::atomic<int> total{0};
    tbb::parallel_for(0, outer_n, [&](int) {
        tbb::parallel_for(0, 1000, [&](int) {
            total.fetch_add(1, std::memory_order_relaxed);
        });
    });
    CHECK(total.load() == outer_n * 1000);
}

TEST(parallel_reduce_functional_form_matches_sequential_sum) {
    const size_t n = 500000;
    std::vector<double> data(n);
    for (size_t i = 0; i < n; ++i) data[i] = static_cast<double>(i % 97) * 0.5;

    double sequential = std::accumulate(data.begin(), data.end(), 0.0);

    double parallel = tbb::parallel_reduce(
        tbb::blocked_range<size_t>(0, n), 0.0,
        [&](const tbb::blocked_range<size_t>& r, double init) {
            for (size_t i = r.begin(); i < r.end(); ++i) init += data[i];
            return init;
        },
        [](double a, double b) { return a + b; });

    // In-order chunked fold vs. strictly sequential accumulate can differ at
    // the ulp level (documented in MT-PLAN.md) — tolerance, not exact.
    CHECK(std::abs(parallel - sequential) < 1e-6);
}

// Reproduces the real call-site shape found by the Phase 2 CI build failure
// (Execution/ExecutionTBB.hpp's reduce(), used by SlicesToTriangleMesh.cpp
// via SLA/SupportTreeBuildsteps.cpp-style code: tbb::blocked_range<iterator>
// through the functional-form parallel_reduce) — same cast-to-iterator bug
// as the parallel_for.h case, just in parallel_reduce.h's independent copy
// of the same chunk-splitting logic.
TEST(parallel_reduce_over_vector_iterator_matches_sequential_sum) {
    const size_t n = 500000;
    std::vector<double> data(n);
    for (size_t i = 0; i < n; ++i) data[i] = static_cast<double>(i % 97) * 0.5;

    double sequential = std::accumulate(data.begin(), data.end(), 0.0);

    double parallel = tbb::parallel_reduce(
        tbb::blocked_range<std::vector<double>::iterator>(data.begin(), data.end()), 0.0,
        [&](const tbb::blocked_range<std::vector<double>::iterator>& r, double init) {
            for (auto& el : r) init += el;
            return init;
        },
        [](double a, double b) { return a + b; });

    CHECK(std::abs(parallel - sequential) < 1e-6);
}

TEST(parallel_invoke_runs_all_branches) {
    std::atomic<int> a{0}, b{0}, c{0};
    tbb::parallel_invoke([&] { a = 1; }, [&] { b = 2; }, [&] { c = 3; });
    CHECK(a.load() == 1);
    CHECK(b.load() == 2);
    CHECK(c.load() == 3);
}

TEST(parallel_for_each_forward_iterator_visits_every_element) {
    std::unordered_set<int> input;
    for (int i = 0; i < 5000; ++i) input.insert(i);

    std::mutex m;
    std::unordered_set<int> seen;
    tbb::parallel_for_each(input.begin(), input.end(), [&](int v) {
        std::lock_guard<std::mutex> lk(m);
        seen.insert(v);
    });
    CHECK(seen.size() == input.size());
}

TEST(spin_mutex_protects_critical_section) {
    tbb::spin_mutex mtx;
    long counter = 0;
    tbb::parallel_for(0, 200000, [&](int) {
        tbb::spin_mutex::scoped_lock lock(mtx);
        ++counter;
    });
    CHECK(counter == 200000);
}

TEST(concurrent_vector_indexed_write_pattern) {
    // Mirrors TreeSupport.cpp's overhangs_all_layers pattern: pre-sized,
    // written via disjoint indexed assignment.
    const size_t n = 20000;
    tbb::concurrent_vector<int> v(n);
    tbb::parallel_for(tbb::blocked_range<size_t>(0, n), [&](const tbb::blocked_range<size_t>& r) {
        for (size_t i = r.begin(); i < r.end(); ++i) v[i] = static_cast<int>(i);
    });
    for (size_t i = 0; i < n; ++i) CHECK(v[i] == static_cast<int>(i));
}

TEST(concurrent_vector_concurrent_push_back_pattern) {
    // Mirrors ConflictChecker.cpp's `conflict.emplace_back(...)` pattern:
    // genuine concurrent append from multiple parallel_for chunks.
    tbb::concurrent_vector<int> v;
    const int n = 20000;
    tbb::parallel_for(0, n, [&](int i) { v.push_back(i); });
    CHECK(v.size() == static_cast<size_t>(n));

    std::vector<int> sorted(v.begin(), v.end());
    std::sort(sorted.begin(), sorted.end());
    for (int i = 0; i < n; ++i) CHECK(sorted[static_cast<size_t>(i)] == i);
}

TEST(concurrent_unordered_map_find_miss_then_insert_race) {
    // The exact TreeSupport.cpp memoization pattern (MT-PLAN.md Phase 1e
    // residual-risk note): find(), and if missing, compute + insert().
    // Stresses the documented iterator-across-insert hazard under TSan.
    tbb::concurrent_unordered_map<int, int> cache;
    const int n = 20000;
    tbb::parallel_for(0, n, [&](int i) {
        int key = i % 500; // heavy key reuse -> real contention on the same buckets
        auto it = cache.find(key);
        if (it == cache.end()) {
            cache.insert({key, key * 2});
        }
    });
    for (int k = 0; k < 500; ++k) {
        auto it = cache.find(k);
        CHECK(it != cache.end());
        CHECK(it->second == k * 2);
    }
}

TEST(concurrent_unordered_map_iterator_survives_rehash) {
    tbb::concurrent_unordered_map<int, int> cache;
    cache.insert({1, 42});
    auto held = cache.find(1);
    for (int i = 2; i < 20000; ++i) cache.insert({i, i});
    CHECK(held != cache.end());
    CHECK(held->second == 42);
}

TEST(parallel_for_rethrows_worker_exception) {
    bool caught = false;
    try {
        tbb::parallel_for(0, 1000, [](int i) {
            if (i == 500) throw std::runtime_error("parallel failure");
        });
    } catch (const std::runtime_error&) {
        caught = true;
    }
    CHECK(caught);
}

TEST(concurrent_unordered_set_count_then_insert_pattern) {
    tbb::concurrent_unordered_set<int> s;
    const int n = 10000;
    tbb::parallel_for(0, n, [&](int i) {
        int key = i % 300;
        if (s.count(key) == 0) s.insert(key);
    });
    CHECK(s.size() == 300);
}

TEST(task_group_waits_for_all_run_calls) {
    tbb::task_group tg;
    std::atomic<int> count{0};
    for (int i = 0; i < 50; ++i) {
        tg.run([&] { count.fetch_add(1, std::memory_order_relaxed); });
    }
    tg.wait();
    CHECK(count.load() == 50);
}

TEST(task_group_rethrows_worker_exception) {
    tbb::task_group tg;
    tg.run([] { throw std::runtime_error("task failure"); });
    bool caught = false;
    try {
        tg.wait();
    } catch (const std::runtime_error&) {
        caught = true;
    }
    CHECK(caught);
}

TEST(global_control_caps_effective_concurrency) {
    int before = tbb::this_task_arena::max_concurrency();
    {
        tbb::global_control gc(tbb::global_control::max_allowed_parallelism, 1);
        CHECK(tbb::this_task_arena::max_concurrency() == 1);
        std::atomic<int> sum{0};
        tbb::parallel_for(0, 1000, [&](int) { sum.fetch_add(1, std::memory_order_relaxed); });
        CHECK(sum.load() == 1000); // still correct, just serialized
    }
    CHECK(tbb::this_task_arena::max_concurrency() == before);
}

int main() {
    std::fprintf(stderr, "\n%d check failure(s)\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
