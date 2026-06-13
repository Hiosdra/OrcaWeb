// WASM override: Google Draco not available.
#include "Format/DRC.hpp"
namespace Slic3r {
bool load_drc(const char*, TriangleMesh*)                { return false; }
bool load_drc(const char*, Model*, const char*)          { return false; }
bool store_drc(const char*, TriangleMesh*, int, int)    { return false; }
bool store_drc(const char*, ModelObject*, int, int)     { return false; }
bool store_drc(const char*, Model*, int, int)           { return false; }
} // namespace Slic3r
