#pragma once

namespace tbb {

class global_control {
public:
    enum parameter { max_allowed_parallelism, stack_size };
    global_control(parameter, std::size_t) {}
    static std::size_t active_value(parameter) { return 1; }
};

} // namespace tbb
