#pragma once

namespace tbb {

// Iterator form — sequential equivalent of tbb::parallel_for_each.
template<typename Iterator, typename Func>
void parallel_for_each(Iterator first, Iterator last, const Func& f) {
    for (Iterator it = first; it != last; ++it) f(*it);
}

// Container form.
template<typename Container, typename Func>
void parallel_for_each(Container& c, const Func& f) {
    for (auto& item : c) f(item);
}

template<typename Container, typename Func>
void parallel_for_each(const Container& c, const Func& f) {
    for (const auto& item : c) f(item);
}

} // namespace tbb
