// Minimal OpenVDB stub for WASM builds.
// OrcaSlicer guards all real OpenVDB calls with SLIC3R_NO_OPENVDB, so this
// header only needs to provide enough types for the code to compile.
#pragma once
#include <cstdint>

namespace openvdb {

using Index32 = uint32_t;
using Index64 = uint64_t;

namespace math { struct Transform {}; }
namespace tools {}
namespace util  {}

inline void initialize() {}

} // namespace openvdb
