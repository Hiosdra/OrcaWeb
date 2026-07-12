#pragma once
#include "detail/thread_pool.h"
#include <cstddef>

namespace tbb {

// max_allowed_parallelism actually caps the shared pool's effective
// concurrency (read by parallel_for/parallel_reduce's chunk-count cap and by
// this_task_arena::max_concurrency()) for as long as this object is alive —
// matches real TBB's RAII scoping, implemented via a simple set-on-construct/
// restore-on-destruct rather than a full stack (libslic3r's 2 call sites,
// per MT-PLAN.md Phase 0, don't nest these).
class global_control {
public:
    enum parameter { max_allowed_parallelism, stack_size };

    global_control(parameter p, std::size_t value) : m_param(p) {
        if (p == max_allowed_parallelism) {
            m_previous = detail::ThreadPool::instance().effective_concurrency();
            detail::ThreadPool::instance().set_max_parallelism(static_cast<int>(value));
        }
    }
    ~global_control() {
        if (m_param == max_allowed_parallelism) {
            detail::ThreadPool::instance().set_max_parallelism(m_previous);
        }
    }
    global_control(const global_control&) = delete;
    global_control& operator=(const global_control&) = delete;

    static std::size_t active_value(parameter p) {
        if (p == max_allowed_parallelism) {
            return static_cast<std::size_t>(detail::ThreadPool::instance().effective_concurrency());
        }
        return 0;
    }

private:
    parameter m_param;
    int m_previous = 0;
};

} // namespace tbb
