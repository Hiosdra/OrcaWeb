#pragma once

namespace tbb {

template<typename F0, typename F1>
void parallel_invoke(F0&& f0, F1&& f1) { f0(); f1(); }

template<typename F0, typename F1, typename F2>
void parallel_invoke(F0&& f0, F1&& f1, F2&& f2) { f0(); f1(); f2(); }

template<typename F0, typename F1, typename F2, typename F3>
void parallel_invoke(F0&& f0, F1&& f1, F2&& f2, F3&& f3)
    { f0(); f1(); f2(); f3(); }

} // namespace tbb
