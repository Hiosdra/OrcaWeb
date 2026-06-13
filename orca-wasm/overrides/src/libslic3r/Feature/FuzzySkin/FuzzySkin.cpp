// WASM override: libnoise and thread_local not available in WASM.
#include "FuzzySkin.hpp"

namespace Slic3r::Feature::FuzzySkin {
void fuzzy_polyline(Points&, bool, coordf_t, const FuzzySkinConfig&) {}
void fuzzy_extrusion_line(Arachne::ExtrusionJunctions&, coordf_t,
                          const FuzzySkinConfig&, bool) {}
void group_region_by_fuzzify(PerimeterGenerator&) {}
bool should_fuzzify(const FuzzySkinConfig&, int, size_t, bool) { return false; }
Polygon apply_fuzzy_skin(const Polygon& p, const PerimeterGenerator&,
                         size_t, bool) { return p; }
void apply_fuzzy_skin(Arachne::ExtrusionLine*, const PerimeterGenerator&,
                      bool) {}
} // namespace Slic3r::Feature::FuzzySkin
