#pragma once
// WASM override: OCCT not available.
// Type aliases and Step class must match the original exactly so that
// Model.hpp's read_from_step declaration compiles without OCCT headers.
#include <functional>
#include <string>
namespace Slic3r {
class Model;

typedef std::function<void(int load_stage, int current, int total, bool& cancel)> ImportStepProgressFn;
typedef std::function<void(bool isUtf8)> StepIsUtf8Fn;

// Minimal Step class — Model.hpp uses Step& in the step_mesh_fn callback type.
class Step {
public:
    enum class Step_Status { LOAD_SUCCESS, LOAD_ERROR, CANCEL, MESH_SUCCESS, MESH_ERROR };
};

extern bool load_step(const char* path, Model* model, bool& is_cancel,
                      double linear_defletion = 0.003,
                      double angle_defletion  = 0.5,
                      bool   isSplitCompound  = false,
                      ImportStepProgressFn proFn    = nullptr,
                      StepIsUtf8Fn         isUtf8Fn = nullptr);
} // namespace Slic3r
