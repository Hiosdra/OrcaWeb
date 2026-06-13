// WASM override: STEP (OCCT) import not available.
// Use "Format/STEP.hpp" (not "STEP.hpp") so the compiler resolves to
// orca/src/libslic3r/Format/STEP.hpp — the same file that Model.hpp
// includes — preventing a redefinition from double-including two copies.
#include "Format/STEP.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Model.hpp"

namespace Slic3r {

bool load_step(const char*, Model*, bool&, double, double, bool,
               ImportStepProgressFn, StepIsUtf8Fn)
{
    throw RuntimeError("STEP import is not supported in the browser build.");
}

Model Model::read_from_step(const std::string&,
                             LoadStrategy,
                             ImportStepProgressFn,
                             StepIsUtf8Fn,
                             std::function<int(Step&, double&, double&, bool&)>,
                             double, double, bool)
{
    throw RuntimeError("STEP import is not supported in the browser build.");
}

} // namespace Slic3r
