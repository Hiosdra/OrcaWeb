#pragma once
#include "detail/thread_pool.h"
#include <array>
#include <functional>

namespace tbb {
namespace detail_pi {

template <typename... Fs>
void invoke_all(Fs&&... fs) {
    // Fold each callable into a type-erased slot so ThreadPool::run's
    // int-indexed task(i) signature can dispatch to any of them; N is small
    // (TBB's parallel_invoke overloads here go up to 4 args) so the erasure
    // cost is irrelevant.
    std::array<std::function<void()>, sizeof...(Fs)> tasks{
        std::function<void()>(std::forward<Fs>(fs))...
    };
    detail::ThreadPool::instance().run(static_cast<int>(tasks.size()),
                                        [&](int i) { tasks[static_cast<size_t>(i)](); });
}

} // namespace detail_pi

template<typename F0, typename F1>
void parallel_invoke(F0&& f0, F1&& f1) {
    detail_pi::invoke_all(std::forward<F0>(f0), std::forward<F1>(f1));
}

template<typename F0, typename F1, typename F2>
void parallel_invoke(F0&& f0, F1&& f1, F2&& f2) {
    detail_pi::invoke_all(std::forward<F0>(f0), std::forward<F1>(f1), std::forward<F2>(f2));
}

template<typename F0, typename F1, typename F2, typename F3>
void parallel_invoke(F0&& f0, F1&& f1, F2&& f2, F3&& f3) {
    detail_pi::invoke_all(std::forward<F0>(f0), std::forward<F1>(f1),
                           std::forward<F2>(f2), std::forward<F3>(f3));
}

} // namespace tbb
