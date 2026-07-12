#pragma once
#include "detail/thread_pool.h"
#include <functional>

namespace tbb {

class task_arena {
public:
    static constexpr int automatic = -1;
    // We have exactly one process-wide pool (see detail/thread_pool.h) — an
    // arena's concurrency request doesn't create a second pool, it only
    // affects what max_concurrency() reports for code that queries this
    // specific arena instance.
    explicit task_arena(int max_concurrency = automatic, unsigned = 1)
        : m_max_concurrency(max_concurrency) {}
    void initialize() {}
    // execute/enqueue run on the calling thread — the body itself typically
    // calls parallel_for/parallel_reduce, which dispatch onto the shared
    // pool; there's no separate arena-local scheduling to do.
    template<typename F> void execute(F&& f) { f(); }
    template<typename F> void enqueue(F&& f) { f(); }
    int max_concurrency() const {
        return (m_max_concurrency == automatic)
            ? detail::ThreadPool::instance().effective_concurrency()
            : m_max_concurrency;
    }
private:
    int m_max_concurrency;
};

namespace this_task_arena {
    inline int max_concurrency() {
        return detail::ThreadPool::instance().effective_concurrency();
    }
    // Safe to run inline: isolate() exists to stop libslic3r's own outer
    // parallel work from being reused as spare capacity for the isolated
    // task, but with a single shared pool + the pool's own re-entrancy rule
    // (thread_pool.h: nested parallel_* calls always run inline on the
    // calling worker) there's no shared scheduler state to isolate from.
    template<typename F> inline void isolate(F&& f) { f(); }
} // namespace this_task_arena

} // namespace tbb
