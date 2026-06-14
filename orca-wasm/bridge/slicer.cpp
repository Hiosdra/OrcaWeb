/**
 * OrcaWeb WASM bridge — clean-room implementation.
 *
 * Exports three C-linkage symbols consumed by the JavaScript runtime:
 *   orc_init(json, len)              → 0 = ok
 *   orc_slice(stl, stlLen, outPtr, outLen) → 0 = ok
 *   orc_free(ptr)
 *   orc_decode_exception(ptr)        → null-terminated UTF-8 string
 *
 * Error codes for orc_slice / orc_init:
 *   -1  invalid / uninitialized state
 *   -2  JSON parse failure
 *   -3  STL write to MEMFS failed
 *   -4  STL load failed
 *   -5  empty model
 *   -6  print validation failed
 *   -7  slicing error
 *   -8  gcode export failed
 *   -9  unexpected C++ exception
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <stdexcept>
#include <memory>

#include <emscripten.h>

// OrcaSlicer core
#include "libslic3r/libslic3r.h"
#include "libslic3r/Model.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Format/STL.hpp"
#include "libslic3r/Format/OBJ.hpp"
#include "libslic3r/GCode.hpp"
#include "libslic3r/Exception.hpp"

// nlohmann/json — available as a bundled dep inside OrcaSlicer
#include <nlohmann/json.hpp>

// ── module state ─────────────────────────────────────────────────────────────
static Slic3r::FullPrintConfig g_defaults;
static Slic3r::DynamicPrintConfig g_config;
static bool g_initialized = false;
static std::string g_last_error;
// Bed centre in mm — computed from bed_size_x / bed_size_y in the config JSON.
// Defaults to centre of a 256×256 mm bed (same as the historical hardcoded value).
static double g_bed_cx = 128.0;
static double g_bed_cy = 128.0;

static void record_error(const char* msg) { g_last_error = msg ? msg : "unknown error"; }
static void record_error(const std::string& s) { g_last_error = s; }

// ── helpers ───────────────────────────────────────────────────────────────────
static std::string json_val_to_string(const nlohmann::json& v) {
    if (v.is_string())  return v.get<std::string>();
    if (v.is_boolean()) return v.get<bool>() ? "1" : "0";
    if (v.is_number())  return std::to_string(v.get<double>());
    return "";
}

// ── public API ────────────────────────────────────────────────────────────────
extern "C" {

/**
 * Initialise the slicer with a JSON config object.
 * All values must be string-encoded exactly as OrcaSlicer stores them
 * (e.g. "0.2", "15%", "1" for true).  Unknown keys are silently ignored.
 */
EMSCRIPTEN_KEEPALIVE
int orc_init(const char* json_data, int json_len) {
    g_last_error.clear();
    try {
        auto j = nlohmann::json::parse(json_data, json_data + json_len);
        if (!j.is_object()) { record_error("config must be a JSON object"); return -2; }

        // Extract bed dimensions (not native OrcaSlicer config keys — used only
        // for model centering below).  The JS layer passes bed_size_x / bed_size_y
        // from the printer preset or from a parsed printable_area.
        {
            auto pick = [&](const char* k, double fallback) -> double {
                if (!j.contains(k)) return fallback;
                const auto& v = j[k];
                if (v.is_number()) return v.get<double>();
                if (v.is_string()) {
                    try { return std::stod(v.get<std::string>()); } catch (...) {}
                }
                return fallback;
            };
            g_bed_cx = pick("bed_size_x", 256.0) / 2.0;
            g_bed_cy = pick("bed_size_y", 256.0) / 2.0;
        }

        // Start from OrcaSlicer's built-in defaults so all required fields exist.
        g_config = Slic3r::DynamicPrintConfig();
        g_config.apply(g_defaults);

        for (auto& [key, val] : j.items()) {
            std::string sv = json_val_to_string(val);
            if (sv.empty()) continue;
            try {
                // set_deserialize_strict builds a ConfigSubstitutionContext with
                // the Disable rule internally (v2.3.2 API); incompatible values
                // throw and are skipped below.
                g_config.set_deserialize_strict(key, sv);
            } catch (...) {
                // silently skip unknown / incompatible keys
            }
        }

        g_initialized = true;
        return 0;
    } catch (const std::exception& e) {
        record_error(e.what());
        return -2;
    }
}

/**
 * Slice an STL file (raw binary, ASCII or binary format).
 * On success *out_gcode points to a malloc'd, null-terminated G-code string
 * and *out_len contains its byte length (excluding the null terminator).
 * Caller must free the buffer with orc_free().
 */
EMSCRIPTEN_KEEPALIVE
int orc_slice(const void* stl_data, int stl_len,
              char** out_gcode, int* out_len) {
    g_last_error.clear();
    if (!g_initialized) { record_error("call orc_init first"); return -1; }
    if (!stl_data || stl_len <= 0 || !out_gcode || !out_len)
        return -1;

    // Write raw STL bytes into Emscripten's MEMFS so OrcaSlicer can read it.
    {
        FILE* f = std::fopen("/tmp/ow_in.stl", "wb");
        if (!f) { record_error("cannot open /tmp/ow_in.stl for writing"); return -3; }
        std::fwrite(stl_data, 1, static_cast<std::size_t>(stl_len), f);
        std::fclose(f);
    }

    try {
        // ── load model ───────────────────────────────────────────────
        Slic3r::Model model;
        if (!Slic3r::load_stl("/tmp/ow_in.stl", &model, "object")) {
            record_error("STL load failed");
            return -4;
        }
        if (model.objects.empty()) {
            record_error("model contains no objects");
            return -5;
        }

        // ── place model on bed ───────────────────────────────────────
        // Center the mesh at origin, then offset to bed centre.
        for (auto* obj : model.objects) {
            obj->center_around_origin();
            if (obj->instances.empty()) {
                auto* inst = obj->add_instance();
                // Place at bed centre, derived from bed_size_x / bed_size_y in config.
                inst->set_offset(Slic3r::Vec3d(g_bed_cx, g_bed_cy, 0.0));
            }
        }

        // ── configure & slice ────────────────────────────────────────
        Slic3r::Print print;
        print.apply(model, g_config);

        {
            // v2.3.2: Print::validate() returns a StringObjectException whose
            // `string` member holds the error message ("" when valid).
            Slic3r::StringObjectException err = print.validate();
            if (!err.string.empty()) { record_error(err.string); return -6; }
        }

        try {
            print.process();
        } catch (const Slic3r::SlicingError& e) {
            record_error(e.what());
            return -7;
        }

        // ── export G-code to MEMFS ───────────────────────────────────
        {
            Slic3r::GCode gcode_gen;
            gcode_gen.do_export(&print, "/tmp/ow_out.gcode", nullptr, nullptr);
        }

        // ── read result back ─────────────────────────────────────────
        FILE* gf = std::fopen("/tmp/ow_out.gcode", "rb");
        if (!gf) { record_error("gcode export produced no output"); return -8; }

        std::fseek(gf, 0, SEEK_END);
        long sz = std::ftell(gf);
        std::rewind(gf);

        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz) + 1));
        if (!buf) { std::fclose(gf); record_error("out of memory"); return -9; }
        std::fread(buf, 1, static_cast<std::size_t>(sz), gf);
        std::fclose(gf);
        buf[sz] = '\0';

        *out_gcode = buf;
        *out_len   = static_cast<int>(sz);
        return 0;

    } catch (const std::exception& e) {
        record_error(e.what());
        return -9;
    }
}

/**
 * Convert an OBJ file (raw bytes) to a binary STL.
 * On success *out_stl points to a malloc'd buffer containing the STL and
 * *out_len contains its byte length.  Caller must free with orc_free().
 *
 * Error codes:
 *   -3  could not write OBJ to MEMFS
 *   -4  OBJ load failed (invalid / unsupported format)
 *   -5  OBJ contains no geometry
 *   -8  STL export failed
 *   -9  unexpected C++ exception
 */
EMSCRIPTEN_KEEPALIVE
int orc_obj_to_stl(const char* obj_data, int obj_len,
                   char** out_stl, int* out_len) {
    g_last_error.clear();
    if (!obj_data || obj_len <= 0 || !out_stl || !out_len) return -1;

    {
        FILE* f = std::fopen("/tmp/ow_in.obj", "wb");
        if (!f) { record_error("cannot open /tmp/ow_in.obj for writing"); return -3; }
        std::fwrite(obj_data, 1, static_cast<std::size_t>(obj_len), f);
        std::fclose(f);
    }

    try {
        Slic3r::Model model;
        Slic3r::ObjInfo obj_info;
        std::string message;
        if (!Slic3r::load_obj("/tmp/ow_in.obj", &model, obj_info, message, "object")) {
            record_error(message.empty() ? "OBJ load failed" : message);
            return -4;
        }
        if (model.objects.empty()) {
            record_error("OBJ contains no geometry");
            return -5;
        }

        // Merge all volumes from all objects into one mesh
        Slic3r::TriangleMesh combined;
        for (auto* obj : model.objects)
            for (auto* vol : obj->volumes)
                combined.merge(vol->mesh());

        if (!Slic3r::store_stl("/tmp/ow_out.stl", &combined, true)) {
            record_error("STL export failed");
            return -8;
        }

        FILE* sf = std::fopen("/tmp/ow_out.stl", "rb");
        if (!sf) { record_error("STL export produced no output"); return -8; }

        std::fseek(sf, 0, SEEK_END);
        long sz = std::ftell(sf);
        std::rewind(sf);

        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz)));
        if (!buf) { std::fclose(sf); record_error("out of memory"); return -9; }
        std::fread(buf, 1, static_cast<std::size_t>(sz), sf);
        std::fclose(sf);

        *out_stl = buf;
        *out_len = static_cast<int>(sz);
        return 0;

    } catch (const std::exception& e) {
        record_error(e.what());
        return -9;
    }
}

/** Free a buffer returned by orc_slice or orc_obj_to_stl. */
EMSCRIPTEN_KEEPALIVE
void orc_free(void* ptr) {
    std::free(ptr);
}

/**
 * Return the last error message as a null-terminated string.
 * The pointer is valid until the next orc_* call.
 */
EMSCRIPTEN_KEEPALIVE
const char* orc_decode_exception(void* /*unused*/) {
    return g_last_error.c_str();
}

} // extern "C"
