// WASM override: STEP (OCCT) import not available.
// Model::read_from_step is defined here so that the SLIC3R_NO_OCCT guard in
// Model.cpp (patch 3d) can remove the OCCT-dependent original definition
// without leaving an undefined symbol.
#include "STEP.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Model.hpp"

namespace Slic3r {

bool load_step(const char*, Model*)
{
    throw RuntimeError("STEP import is not supported in the browser build.");
}

Model Model::read_from_step(const char*, ImportStepProgressFn, StepIsUtf8Fn)
{
    throw RuntimeError("STEP import is not supported in the browser build.");
}

} // namespace Slic3r
