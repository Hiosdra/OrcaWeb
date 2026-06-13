// WASM override: OCCT (SVG-to-mesh import) not available.
#include "svg.hpp"
namespace Slic3r {
bool load_svg(const char*, Model*, std::string&) { return false; }
} // namespace Slic3r
