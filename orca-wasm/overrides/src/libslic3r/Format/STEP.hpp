#pragma once
// WASM override: OCCT not available.
// Provides only the type aliases Model.hpp needs for read_from_step() signature.
#include <functional>
namespace Slic3r {
class Model;
using ImportStepProgressFn = std::function<void(int, int)>;
using StepIsUtf8Fn         = std::function<bool()>;
bool load_step(const char* path, Model* model);
} // namespace Slic3r
