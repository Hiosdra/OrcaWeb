#pragma once
#include <functional>

namespace tbb {

class task_group {
public:
    template<typename F> void run(F&& f)          { f(); }
    template<typename F> void run_and_wait(F&& f) { f(); }
    void wait() {}
    void cancel() {}
};

class task_group_context {
public:
    enum kind_t { isolated, bound };
    explicit task_group_context(kind_t = bound) {}
    void cancel_group_execution() {}
    bool is_group_execution_cancelled() const { return false; }
};

} // namespace tbb
