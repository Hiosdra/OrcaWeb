#pragma once
#include <cstddef>
#include <functional>
#include <vector>
#include <any>
#include <cassert>

// Sequential (single-threaded) implementation of tbb::parallel_pipeline for WASM.
// All stages are run serially: the generator is called once per token until it
// calls fc.stop(), and each token is immediately passed through the remaining
// stages before the next token is generated.

namespace tbb {

// --- filter_mode (modern TBB >= 2021 API) ---
enum class filter_mode {
    parallel            = 0,
    serial_in_order     = 1,
    serial_out_of_order = 2,
};

// --- flow_control ---
class flow_control {
public:
    void stop() { m_stopped = true; }
    bool is_stopped() const { return m_stopped; }
private:
    bool m_stopped = false;
};

// --- internal stage representation ---
namespace _impl {

struct stage {
    enum class kind { generator, transform };
    kind m_kind = kind::transform;
    std::function<std::any(flow_control&)> m_gen;    // first stage
    std::function<std::any(std::any)>      m_xform;  // all other stages
};

// Helper: make_filter for first stage (T = void) — lambda takes flow_control&
template<typename U, typename Fn>
stage make_generator(Fn&& fn) {
    stage s;
    s.m_kind = stage::kind::generator;
    s.m_gen  = [f = std::forward<Fn>(fn)](flow_control& fc) -> std::any {
        return std::any(f(fc));
    };
    return s;
}

// Helper: make_filter for middle stages (T != void, U != void) — lambda takes T
template<typename T, typename U, typename Fn>
stage make_transform(Fn&& fn) {
    stage s;
    s.m_kind  = stage::kind::transform;
    s.m_xform = [f = std::forward<Fn>(fn)](std::any in) -> std::any {
        return std::any(f(std::any_cast<T>(std::move(in))));
    };
    return s;
}

// Helper: make_filter for last stage (U = void) — lambda takes T, returns nothing
template<typename T, typename Fn>
stage make_sink(Fn&& fn) {
    stage s;
    s.m_kind  = stage::kind::transform;
    s.m_xform = [f = std::forward<Fn>(fn)](std::any in) -> std::any {
        f(std::any_cast<T>(std::move(in)));
        return {};
    };
    return s;
}

} // namespace _impl

// --- filter_t ---
class filter_t {
public:
    std::vector<_impl::stage> _stages;

    filter_t() = default;
    explicit filter_t(_impl::stage s) { _stages.push_back(std::move(s)); }

    filter_t operator&(const filter_t& rhs) const {
        filter_t result;
        result._stages = _stages;
        result._stages.insert(result._stages.end(), rhs._stages.begin(), rhs._stages.end());
        return result;
    }
};

// --- make_filter<T, U> dispatch ---
// Intermediate dispatch struct so we can partially specialise on T and U.
template<typename T, typename U>
struct _make_filter_dispatch {
    template<typename Fn>
    static filter_t apply(filter_mode /*mode*/, Fn&& fn) {
        return filter_t(_impl::make_transform<T, U>(std::forward<Fn>(fn)));
    }
};

// T = void → generator stage
template<typename U>
struct _make_filter_dispatch<void, U> {
    template<typename Fn>
    static filter_t apply(filter_mode /*mode*/, Fn&& fn) {
        return filter_t(_impl::make_generator<U>(std::forward<Fn>(fn)));
    }
};

// U = void → sink stage
template<typename T>
struct _make_filter_dispatch<T, void> {
    template<typename Fn>
    static filter_t apply(filter_mode /*mode*/, Fn&& fn) {
        return filter_t(_impl::make_sink<T>(std::forward<Fn>(fn)));
    }
};

template<typename T, typename U, typename Fn>
inline filter_t make_filter(filter_mode mode, Fn&& fn) {
    return _make_filter_dispatch<T, U>::template apply(mode, std::forward<Fn>(fn));
}

// --- parallel_pipeline (sequential shim) ---
// Runs the pipeline in a tight loop: generate one token, pass it through every
// subsequent stage, then repeat — until the generator calls fc.stop().
inline void parallel_pipeline(std::size_t /*max_tokens*/, const filter_t& pipeline) {
    const auto& stages = pipeline._stages;
    if (stages.empty()) return;
    assert(stages[0].m_kind == _impl::stage::kind::generator);

    flow_control fc;
    while (!fc.is_stopped()) {
        std::any token = stages[0].m_gen(fc);
        if (fc.is_stopped()) break;

        std::any current = std::move(token);
        for (std::size_t i = 1; i < stages.size(); ++i)
            current = stages[i].m_xform(std::move(current));
    }
}

} // namespace tbb
