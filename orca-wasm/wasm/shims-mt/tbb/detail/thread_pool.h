#pragma once
// Fixed-size thread pool backing the shims-mt/ TBB-compatible primitives.
//
// See orca-wasm/MT-PLAN.md Phase 1a/1b for the design rationale — in
// particular why pool size must equal what this_task_arena::max_concurrency()
// reports (Thread.cpp's startup barrier requires it), and why dispatch chunk
// counts must be capped at the pool's *actual* live worker count rather than
// an uncapped grain-implied count (most libslic3r call sites default to
// grain=1 over large ranges; uncapped that's one task per index).
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace tbb {
namespace detail {

class ThreadPool {
public:
    static ThreadPool& instance() {
        static ThreadPool pool;
        return pool;
    }

    // Actual live worker count — may be less than requested if pthread_create
    // failed partway through startup. Never a stale/aspirational number:
    // callers (parallel_for's chunk-count cap, this_task_arena::max_concurrency)
    // must use this, not a separately-remembered "intended" size, so that a
    // degraded pool and its callers stay mutually consistent.
    int size() const { return static_cast<int>(workers_.size()); }

    // Runs `count` independent tasks (task(i) for i in [0, count)) and blocks
    // until all complete. Safe to call from a pool worker thread (nested
    // parallelism): falls back to running everything inline on the calling
    // thread rather than enqueueing, which would deadlock (the worker would
    // be waiting for itself to finish a task it can never get back to).
    template <typename F>
    void run(int count, F&& task) {
        if (count <= 0) return;
        if (count == 1 || in_pool_worker_ || workers_.empty()) {
            for (int i = 0; i < count; ++i) task(i);
            return;
        }

        // Shared completion state, kept alive by the lambdas captured into
        // the queue even if this frame's own use ends first (it won't, we
        // block below, but shared_ptr keeps this trivially exception-safe).
        auto remaining = std::make_shared<std::atomic<int>>(count);
        auto done_mutex = std::make_shared<std::mutex>();
        auto done_cv = std::make_shared<std::condition_variable>();
        auto exception_mutex = std::make_shared<std::mutex>();
        auto first_exception = std::make_shared<std::exception_ptr>();

        {
            std::lock_guard<std::mutex> lk(queue_mutex_);
            for (int i = 0; i < count; ++i) {
                queue_.push_back([&task, i, remaining, done_mutex, done_cv,
                                  exception_mutex, first_exception]() {
                    try {
                        task(i);
                    } catch (...) {
                        std::lock_guard<std::mutex> exception_lock(*exception_mutex);
                        if (!*first_exception) *first_exception = std::current_exception();
                    }
                    if (remaining->fetch_sub(1, std::memory_order_acq_rel) == 1) {
                        std::lock_guard<std::mutex> lk2(*done_mutex);
                        done_cv->notify_all();
                    }
                });
            }
        }
        queue_cv_.notify_all();

        std::unique_lock<std::mutex> lk(*done_mutex);
        done_cv->wait(lk, [&] { return remaining->load(std::memory_order_acquire) == 0; });
        lk.unlock();
        if (*first_exception) std::rethrow_exception(*first_exception);
    }

    // Fire-and-forget enqueue for task_group: schedules `fn` and returns
    // immediately (the caller tracks its own completion, e.g. task_group's
    // pending counter). Same re-entrancy fallback as run(): inline execution
    // when called from a pool worker or when the pool has no workers.
    template <typename F>
    void submit(F&& fn) {
        if (in_pool_worker_ || workers_.empty()) {
            fn();
            return;
        }
        {
            std::lock_guard<std::mutex> lk(queue_mutex_);
            queue_.push_back(std::forward<F>(fn));
        }
        queue_cv_.notify_one();
    }

    // Max_allowed_parallelism support for tbb::global_control — caps how many
    // workers dispatch() will report/use without tearing the pool down.
    void set_max_parallelism(int n) {
        active_limit_.store(n < 0 ? static_cast<int>(workers_.size()) : n,
                             std::memory_order_relaxed);
    }

    // What parallel_for's chunk-count cap and this_task_arena::max_concurrency()
    // should actually use: live workers, further capped by any
    // global_control(max_allowed_parallelism, N) currently in effect. Real
    // TBB's max_concurrency() is never 0 — the calling thread itself always
    // counts as one unit of concurrency, even with zero background workers
    // (found by the Phase 1 test suite at TBB_SHIM_MT_THREADS=0: without this
    // floor, Thread.cpp's nthreads == max_concurrency() barrier would be
    // built for nthreads == 0 and never run at all instead of degrading to
    // one synchronous "thread").
    int effective_concurrency() const {
        int live = static_cast<int>(workers_.size());
        int limit = active_limit_.load(std::memory_order_relaxed);
        int base = (limit > 0 && limit < live) ? limit : live;
        return base < 1 ? 1 : base;
    }

private:
    ThreadPool() {
        unsigned hw = std::thread::hardware_concurrency();
        if (hw == 0) hw = 4;
        unsigned n = std::min(hw, 8u);
        // Test-only override so the Phase 1 unit tests can exercise small
        // and degraded pool sizes deterministically.
        if (const char* env = std::getenv("TBB_SHIM_MT_THREADS")) {
            int v = std::atoi(env);
            if (v >= 0) n = static_cast<unsigned>(v);
        }
        for (unsigned i = 0; i < n; ++i) {
            try {
                workers_.emplace_back([this] { worker_loop(); });
            } catch (...) {
                // pthread_create failed (thread-limit exhaustion etc.) —
                // degrade to whatever count actually spawned, never crash.
                // A pool of size() == 0 makes run() fall back to fully
                // inline execution, matching today's sequential shim.
                break;
            }
        }
        active_limit_.store(static_cast<int>(workers_.size()), std::memory_order_relaxed);
    }

    ~ThreadPool() {
        {
            std::lock_guard<std::mutex> lk(queue_mutex_);
            stop_ = true;
        }
        queue_cv_.notify_all();
        for (auto& t : workers_) {
            if (t.joinable()) t.join();
        }
    }

    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    void worker_loop() {
        in_pool_worker_ = true;
        for (;;) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lk(queue_mutex_);
                queue_cv_.wait(lk, [this] { return stop_ || !queue_.empty(); });
                if (stop_ && queue_.empty()) return;
                task = std::move(queue_.front());
                queue_.pop_front();
            }
            task();
        }
    }

    std::vector<std::thread> workers_;
    std::deque<std::function<void()>> queue_;
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    bool stop_ = false;
    std::atomic<int> active_limit_{0};

    static thread_local bool in_pool_worker_;
};

inline thread_local bool ThreadPool::in_pool_worker_ = false;

} // namespace detail
} // namespace tbb
