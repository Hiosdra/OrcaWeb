// WASM override: Google Draco not available.
#include "DRC.hpp"
namespace Slic3r {
bool load_drc(const char*, TriangleMesh*)               { return false; }
bool load_drc(const char*, Model*, const char*)         { return false; }
bool store_drc(const TriangleMesh&, const char*, int, int)  { return false; }
bool store_drc(const ModelObject&, const char*, int, int)   { return false; }
bool store_drc(const Model&,       const char*, int, int)   { return false; }
} // namespace Slic3r
