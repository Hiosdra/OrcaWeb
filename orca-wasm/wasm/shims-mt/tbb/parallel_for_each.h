#pragma once
#include "detail/thread_pool.h"
#include <mutex>

namespace tbb {

// Iterator form. libslic3r call sites (MT-PLAN.md Phase 0) don't guarantee
// random access, so this can't use index-based chunking like parallel_for.
// Instead: a shared cursor advanced under a lock (copy the current iterator,
// increment the shared one, unlock, then dereference the *copy* outside the
// lock) — correct for any iterator category, including forward-only, and is
// the same technique real TBB uses internally for non-random-access ranges.
template<typename Iterator, typename Func>
void parallel_for_each(Iterator first, Iterator last, const Func& f) {
    const int pool_n = detail::ThreadPool::instance().effective_concurrency();
    if (pool_n <= 1 || first == last) {
        for (Iterator it = first; it != last; ++it) f(*it);
        return;
    }

    Iterator cursor = first;
    std::mutex cursor_mutex;
    bool exhausted = false;

    // Worker count, not item count, is the task count here — each worker
    // loops pulling items off the shared cursor until it's exhausted, rather
    // than pre-splitting (which needs random access / a known distance).
    detail::ThreadPool::instance().run(pool_n, [&](int /*idx*/) {
        for (;;) {
            Iterator current;
            {
                std::lock_guard<std::mutex> lk(cursor_mutex);
                if (exhausted || cursor == last) {
                    exhausted = true;
                    return;
                }
                current = cursor;
                ++cursor;
            }
            f(*current);
        }
    });
}

// Container form.
template<typename Container, typename Func>
void parallel_for_each(Container& c, const Func& f) {
    parallel_for_each(c.begin(), c.end(), f);
}
template<typename Container, typename Func>
void parallel_for_each(const Container& c, const Func& f) {
    parallel_for_each(c.begin(), c.end(), f);
}

} // namespace tbb
