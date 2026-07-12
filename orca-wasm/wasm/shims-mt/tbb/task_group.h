#pragma once
#include "detail/thread_pool.h"
#include <atomic>
#include <condition_variable>
#include <exception>
#include <mutex>

namespace tbb {

// Tracks completion of everything run() has submitted since construction (or
// since the last wait()) — real TBB task_group semantics.
class task_group {
public:
    template<typename F>
    void run(F&& f) {
        m_pending.fetch_add(1, std::memory_order_acq_rel);
        detail::ThreadPool::instance().submit([this, fn = std::forward<F>(f)]() mutable {
            std::exception_ptr error;
            try {
                fn();
            } catch (...) {
                error = std::current_exception();
            }
            // m_pending must be decremented *while holding m_mutex*, not
            // before — found by TSan flagging a real race in ~task_group():
            // with the decrement outside the lock, wait()'s predicate could
            // observe m_pending==0 (a spurious wakeup rechecks the predicate
            // without needing an actual notify) and return — letting the
            // caller destroy the task_group — while this thread was still
            // blocked acquiring m_mutex to notify, i.e. destroying a mutex
            // another thread is blocked on. Doing the decrement under the
            // same lock wait() reads it under means: by the time wait() can
            // ever observe m_pending==0, this thread has already released
            // m_mutex (mutual exclusion), so it can no longer be blocked
            // trying to acquire it.
            std::lock_guard<std::mutex> lk(m_mutex);
            if (error && !m_exception) m_exception = error;
            if (m_pending.fetch_sub(1, std::memory_order_acq_rel) == 1) {
                m_cv.notify_all();
            }
        });
    }

    template<typename F>
    void run_and_wait(F&& f) {
        f();
        wait();
    }

    void wait() {
        std::unique_lock<std::mutex> lk(m_mutex);
        m_cv.wait(lk, [this] { return m_pending.load(std::memory_order_acquire) == 0; });
        auto error = m_exception;
        m_exception = nullptr;
        lk.unlock();
        if (error) std::rethrow_exception(error);
    }

    // Best-effort: no task in libslic3r's real usage (MT-PLAN.md Phase 0, 3
    // call sites) relies on mid-flight cancellation actually interrupting
    // work — matches the sequential shim's existing no-op semantics.
    void cancel() {}

private:
    std::atomic<int> m_pending{0};
    std::mutex m_mutex;
    std::condition_variable m_cv;
    std::exception_ptr m_exception;
};

class task_group_context {
public:
    enum kind_t { isolated, bound };
    explicit task_group_context(kind_t = bound) {}
    void cancel_group_execution() {}
    bool is_group_execution_cancelled() const { return false; }
};

} // namespace tbb
