#pragma once
#include <functional>

namespace tbb {

class task_arena {
public:
    static constexpr int automatic = -1;
    explicit task_arena(int = automatic, unsigned = 1) {}
    void initialize() {}
    template<typename F> void execute(F&& f) { f(); }
    template<typename F> void enqueue(F&& f) { f(); }
    int max_concurrency() const { return 1; }
};

namespace this_task_arena {
    inline int max_concurrency() { return 1; }
    template<typename F> inline void isolate(F&& f) { f(); }
} // namespace this_task_arena

} // namespace tbb
