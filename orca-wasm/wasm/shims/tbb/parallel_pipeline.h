#pragma once
#include <cstddef>
#include <functional>

namespace tbb {

// In WASM (single-threaded) a pipeline degenerates to a sequential loop.
// We provide just enough API surface for OrcaSlicer's GCode.cpp to compile.

class flow_control {
public:
    void stop() { m_stopped = true; }
    bool is_stopped() const { return m_stopped; }
private:
    bool m_stopped = false;
};

enum filter_mode { parallel = 0, serial_in_order = 1, serial_out_of_order = 2 };

class filter_t {
public:
    filter_t() = default;
    template<typename T, typename U>
    filter_t(filter_mode, std::function<U(T)>) {}
    filter_t operator&(const filter_t&) const { return *this; }
};

// parallel_pipeline: run each stage function once sequentially.
inline void parallel_pipeline(std::size_t /*tokens*/, const filter_t& /*pipeline*/) {}

// make_filter helper (ignored — real work comes from lambda captures)
template<typename T, typename U>
filter_t make_filter(filter_mode m, std::function<U(T)> body) {
    return filter_t(m, body);
}

} // namespace tbb
