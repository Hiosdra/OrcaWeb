#pragma once
// WASM shim: scalable_allocator -> std::allocator (no TBB malloc in emscripten)
#include <memory>

namespace oneapi { namespace tbb {
    template <typename T>
    using scalable_allocator = std::allocator<T>;
} } // oneapi::tbb

namespace tbb {
    template <typename T>
    using scalable_allocator = std::allocator<T>;
} // tbb
