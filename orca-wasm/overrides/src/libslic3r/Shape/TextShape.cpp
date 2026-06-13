// WASM override: OCCT (text shapes) not available.
#include "TextShape.hpp"
#include <map>
#include <string>
#include <vector>

namespace Slic3r {
std::vector<std::string> init_occt_fonts() { return {}; }
void load_text_shape(const char*, const char*, float, float,
                     bool, bool, TextResult&) {}
std::map<std::string, std::string> get_occt_fonts_maps() { return {}; }
} // namespace Slic3r
