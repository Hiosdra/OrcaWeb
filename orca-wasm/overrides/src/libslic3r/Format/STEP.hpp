#pragma once
// WASM override: OCCT not available.
// Provides all types/aliases that Model.hpp references unconditionally.
#include <functional>
namespace Slic3r {
class Model;
// Placeholder for the OCCT-backed step-mesh context passed via step_mesh_fn callbacks.
struct Step {};
using ImportStepProgressFn = std::function<void(int, int)>;
using StepIsUtf8Fn         = std::function<bool()>;
bool load_step(const char* path, Model* model);
} // namespace Slic3r
