/**
 * OrcaWeb WASM bridge — clean-room implementation.
 *
 * Exports C-linkage symbols consumed by the JavaScript runtime:
 *   orc_session_create()                                          → opaque session handle (0 = alloc failed)
 *   orc_session_destroy(session)
 *   orc_init(session, json, len)                                  → 0 = ok
 *   orc_slice(session, stl, stlLen, outPtr, outLen)                → 0 = ok
 *   orc_slice_multi(session, all, allLen, offsets, n,
 *                   extruderIds, out, outLen)                     → 0 = ok
 *   orc_obj_to_stl(obj, objLen, outPtr, outLen)                   → 0 = ok
 *   orc_cad_to_stl(cad, cadLen, outPtr, outLen)                   → 0 = ok (STEP)
 *   orc_write_3mf(session, stl, stlLen, outPtr, outLen)           → 0 = ok
 *   orc_free(ptr)
 *   orc_decode_exception(session)                                 → null-terminated UTF-8 string
 *
 * orc_obj_to_stl / orc_cad_to_stl are pure format conversions — they never
 * touch slicer config state, so they take no session handle.
 *
 * Error codes for orc_slice / orc_init / orc_slice_multi / orc_write_3mf:
 *   -1  invalid / uninitialized state (includes a null/invalid session handle)
 *   -2  JSON parse failure
 *   -3  STL write to MEMFS failed
 *   -4  STL load failed
 *   -5  empty model
 *   -6  print validation failed
 *   -7  slicing error
 *   -8  gcode export failed (or, for orc_write_3mf, 3MF export failed)
 *   -9  unexpected C++ exception
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <stdexcept>
#include <memory>
#include <new>
#include <sys/stat.h>

#include <emscripten.h>

// OrcaSlicer core
#include "libslic3r/libslic3r.h"
#include "libslic3r/Model.hpp"
#include "libslic3r/ModelArrange.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Format/STL.hpp"
#include "libslic3r/Format/OBJ.hpp"
#include "libslic3r/Format/STEP.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/GCode.hpp"
#include "libslic3r/Exception.hpp"

#include <boost/algorithm/string/predicate.hpp>
#include <boost/log/core.hpp>

// nlohmann/json — available as a bundled dep inside OrcaSlicer
#include <nlohmann/json.hpp>

// Boost.Log is unusable in this build: no sink is ever registered (utils.cpp's
// file sink needs set_logging_file(), which only the desktop CLI calls), so
// every record that passes the severity filter — left at `warning` by
// utils.cpp's RunOnInit — goes to Boost.Log's *default* sink. Under this
// single-threaded (BOOST_LOG_NO_THREADS) Emscripten build that path is both
// broken and expensive: it non-deterministically traps with "memory access
// out of bounds" inside core::push_record_move() (first seen as the
// nozzle_info.json incident — see ensure_nozzle_info_json() below — and again
// with the Voron Design Cube, where Arachne's per-edge warning storm during
// Voronoi-diagram repair either traps or burns most of the slice's CPU in
// record formatting, turning a multi-second slice into a multi-minute one).
// The records are unobservable either way, so disable the logging core
// outright instead of dodging individual call sites.
static struct DisableBoostLogOnInit {
    DisableBoostLogOnInit() { boost::log::core::get()->set_logging_enabled(false); }
} g_disable_boost_log;

// ── module state ─────────────────────────────────────────────────────────────
// Read-only template of OrcaSlicer's built-in defaults — constructed once,
// never mutated afterwards, so it's safe to share across every session.
static Slic3r::FullPrintConfig g_defaults;

// Per-session engine state, behind an opaque handle instead of process-wide
// statics. Today the JS side still creates exactly one session per worker
// and uses it for that worker's entire lifetime, so behaviour is unchanged —
// this only removes the structural blocker that made it unsafe for a future
// caller (a Node CLI batch-processing many jobs, or a worker pool) to hold
// more than one independent slicer session in the same WASM instance.
struct OrcSession {
    Slic3r::DynamicPrintConfig config;
    bool initialized = false;
    std::string last_error;
    // Bed centre in mm — computed from bed_size_x / bed_size_y in the config JSON.
    // Defaults to centre of a 256×256 mm bed (same as the historical hardcoded value).
    double bed_cx = 128.0;
    double bed_cy = 128.0;
    // "rectangle" or "circle" — read from bed_shape in the config JSON.
    std::string bed_shape = "rectangle";
};

static OrcSession* as_session(void* ptr) { return static_cast<OrcSession*>(ptr); }

static void record_error(OrcSession& s, const char* msg) { s.last_error = msg ? msg : "unknown error"; }
static void record_error(OrcSession& s, const std::string& str) { s.last_error = str; }

// orc_obj_to_stl / orc_cad_to_stl are pure format conversions with no config
// state, so they don't need a session — but the JS caller still wants
// orc_decode_exception() to work for them. Keep a small dedicated error slot
// for these two functions; orc_decode_exception(0) (JS's existing call
// pattern for conversion errors) falls back to it when no session is passed.
static std::string g_conversion_last_error;
static void record_error(const char* msg) { g_conversion_last_error = msg ? msg : "unknown error"; }
static void record_error(const std::string& str) { g_conversion_last_error = str; }

// Unconditionally removes a MEMFS temp file on scope exit (success, early
// return, or C++ exception alike). Without this, a throw from do_export()
// (or anything else between file creation and the manual std::remove() at
// the bottom of the happy path) left the partially-written file behind —
// MEMFS is RAM-backed, so that's a real per-failed-slice memory leak over a
// long session, not just a stray file. std::remove() on a missing path is a
// harmless no-op (ENOENT), so double-removal on the happy path is fine.
struct TempFileGuard {
    std::string path;
    explicit TempFileGuard(std::string p) : path(std::move(p)) {}
    ~TempFileGuard() { std::remove(path.c_str()); }
    TempFileGuard(const TempFileGuard&) = delete;
    TempFileGuard& operator=(const TempFileGuard&) = delete;
};

// ── helpers ───────────────────────────────────────────────────────────────────
static std::string json_val_to_string(const nlohmann::json& v) {
    if (v.is_string())  return v.get<std::string>();
    if (v.is_boolean()) return v.get<bool>() ? "1" : "0";
    if (v.is_number())  return std::to_string(v.get<double>());
    return "";
}

// ModelObject::center_around_origin() centers the raw mesh bounding box on
// *all three* axes, including Z — it's meant to be called with an existing
// instance that absorbs the shift (see its desktop usage), which then
// re-lands the object on the bed. This bridge calls it before any instance
// exists, so nothing compensates for the Z shift: the mesh's own vertical
// midpoint (not its bottom) ends up at bed level, and the object floats
// half above / half below Z=0. Desktop Orca's bed-centering only recenters
// X/Y and leaves Z exactly as authored in the source mesh — do the same here.
static void center_object_xy_only(Slic3r::ModelObject* obj) {
    Slic3r::Vec3d shift = -obj->raw_mesh_bounding_box().center();
    shift.z() = 0.0;
    obj->translate(shift);
    obj->origin_translation += shift;
}

// Print::m_isBBLPrinter (accessed via is_BBL_printer()) has no default
// member initializer and is otherwise only ever assigned by desktop GUI code
// (BackgroundSlicingProcess.cpp, OrcaSlicer.cpp) from PresetBundle's vendor
// info — none of which runs in this headless bridge. Left unset, it reads
// as uninitialized memory, which GCode.cpp uses to pick between the Bambu
// and "compatible" (;TYPE: ...) reserved-tag formats when writing extrusion
// role comments. A mismatch between that and what desktop OrcaSlicer expects
// when re-opening the file (it infers the format from the exported
// printer_model config) makes every extrusion role show as "Undefined" in
// the Line Type breakdown. Mirror the same "Bambu Lab" vendor-name prefix
// check GUI code uses so it's set deterministically from the same
// printer_model the JS layer already sends.
static void set_is_bbl_printer(Slic3r::Print& print, const Slic3r::DynamicPrintConfig& config) {
    print.is_BBL_printer() = boost::starts_with(config.opt_string("printer_model"), "Bambu Lab");
}

// ── public API ────────────────────────────────────────────────────────────────
extern "C" {

/** Allocate a new engine session. Returns 0 (null) on allocation failure. */
EMSCRIPTEN_KEEPALIVE
void* orc_session_create() {
    return new (std::nothrow) OrcSession();
}

/** Free a session created by orc_session_create(). Safe to call with null. */
EMSCRIPTEN_KEEPALIVE
void orc_session_destroy(void* session_ptr) {
    delete as_session(session_ptr);
}

/**
 * Initialise the slicer with a JSON config object.
 * All values must be string-encoded exactly as OrcaSlicer stores them
 * (e.g. "0.2", "15%", "1" for true).  Unknown keys are silently ignored.
 */
// Print::get_hrc_by_nozzle_type() (Print.cpp) reads "info/nozzle_info.json"
// relative to Slic3r::resources_dir(), which our bridge never sets (empty
// string) since we ship no /resources tree. The parse always fails there,
// which is handled — but the BOOST_LOG_TRIVIAL(error) call on that failure
// path traps with "memory access out of bounds" inside boost::log's
// single-threaded core on every single slice, even for trivial models.
// Pre-seed the file in MEMFS so the parse succeeds and that log call (and
// whatever makes it crash) is never reached, rather than patching boost::log.
static void ensure_nozzle_info_json() {
    static bool written = false;
    if (written) return;
    ::mkdir("info", 0755); // ignore EEXIST
    if (FILE* f = std::fopen("info/nozzle_info.json", "wb")) {
        static const char kJson[] =
            R"({"nozzle_hrc":{"hardened_steel":55,"stainless_steel":20,"tungsten_carbide":85,"brass":2,"undefine":0}})";
        std::fwrite(kJson, 1, sizeof(kJson) - 1, f);
        std::fclose(f);
    }
    written = true;
}

EMSCRIPTEN_KEEPALIVE
int orc_init(void* session_ptr, const char* json_data, int json_len) {
    OrcSession* session = as_session(session_ptr);
    if (!session) return -1;
    session->last_error.clear();
    ensure_nozzle_info_json();
    try {
        auto j = nlohmann::json::parse(json_data, json_data + json_len);
        if (!j.is_object()) { record_error(*session, "config must be a JSON object"); return -2; }

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
            session->bed_cx = pick("bed_size_x", 256.0) / 2.0;
            session->bed_cy = pick("bed_size_y", 256.0) / 2.0;
            session->bed_shape = (j.contains("bed_shape") && j["bed_shape"].is_string())
                ? j["bed_shape"].get<std::string>()
                : "rectangle";
        }

        // Start from OrcaSlicer's built-in defaults so all required fields exist.
        session->config = Slic3r::DynamicPrintConfig();
        session->config.apply(g_defaults);

        // use_relative_e_distances defaults to true ("Default is checked" —
        // PrintConfig.cpp) but Print::validate() (Print.cpp) hard-fails
        // *every* slice under relative addressing unless layer_gcode
        // contains "G92 E0" — normally supplied by a real printer profile's
        // start/layer G-code, none of which we ship in this headless build.
        // Without this default every slice through the real app failed
        // validation (-6) with "Relative extruder addressing requires
        // resetting the extruder position...". Absolute addressing (0)
        // needs no such G-code and works on effectively all firmwares.
        // Callers can still opt into relative addressing explicitly if they
        // also supply appropriate layer_gcode.
        session->config.set_deserialize_strict("use_relative_e_distances", "0");

        for (auto& [key, val] : j.items()) {
            std::string sv = json_val_to_string(val);
            if (sv.empty()) continue;
            try {
                // set_deserialize_strict builds a ConfigSubstitutionContext with
                // the Disable rule internally; incompatible values throw and are
                // skipped below.
                session->config.set_deserialize_strict(key, sv);
            } catch (...) {
                // silently skip unknown / incompatible keys
            }
        }

        session->initialized = true;
        return 0;
    } catch (const std::exception& e) {
        record_error(*session, e.what());
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
int orc_slice(void* session_ptr, const void* stl_data, int stl_len,
              char** out_gcode, int* out_len) {
    OrcSession* session = as_session(session_ptr);
    if (!session) return -1;
    session->last_error.clear();
    if (!session->initialized) { record_error(*session, "call orc_init first"); return -1; }
    if (!stl_data || stl_len <= 0 || !out_gcode || !out_len)
        return -1;

    // Write raw STL bytes into Emscripten's MEMFS so OrcaSlicer can read it.
    {
        FILE* f = std::fopen("/tmp/ow_in.stl", "wb");
        if (!f) { record_error(*session, "cannot open /tmp/ow_in.stl for writing"); return -3; }
        std::fwrite(stl_data, 1, static_cast<std::size_t>(stl_len), f);
        std::fclose(f);
    }

    try {
        // ── load model ───────────────────────────────────────────────
        Slic3r::Model model;
        const bool stl_ok = Slic3r::load_stl("/tmp/ow_in.stl", &model, "object");
        std::remove("/tmp/ow_in.stl"); // MEMFS is RAM-backed; free it as soon as loaded
        if (!stl_ok) {
            record_error(*session, "STL load failed");
            return -4;
        }
        if (model.objects.empty()) {
            record_error(*session, "model contains no objects");
            return -5;
        }

        // ── place model on bed ───────────────────────────────────────
        // Center the mesh in X/Y, then offset to bed centre.
        for (auto* obj : model.objects) {
            center_object_xy_only(obj);
            if (obj->instances.empty()) {
                auto* inst = obj->add_instance();
                // Place at bed centre, derived from bed_size_x / bed_size_y in config.
                inst->set_offset(Slic3r::Vec3d(session->bed_cx, session->bed_cy, 0.0));
            }
        }

        // ── configure & slice ────────────────────────────────────────
        Slic3r::Print print;
        print.apply(model, session->config);
        set_is_bbl_printer(print, session->config);

        {
            // Print::validate() returns a StringObjectException whose
            // `string` member holds the error message ("" when valid).
            Slic3r::StringObjectException err = print.validate();
            if (!err.string.empty()) { record_error(*session, err.string); return -6; }
        }

        try {
            print.process();
        } catch (const Slic3r::SlicingError& e) {
            record_error(*session, e.what());
            return -7;
        }

        // ── export G-code to MEMFS ───────────────────────────────────
        // Guard covers the do_export() call too: if it throws partway through
        // writing, the partial file is still removed on the way out.
        TempFileGuard out_guard("/tmp/ow_out.gcode");
        {
            Slic3r::GCode gcode_gen;
            gcode_gen.do_export(&print, "/tmp/ow_out.gcode", nullptr, nullptr);
        }

        // ── read result back ─────────────────────────────────────────
        FILE* gf = std::fopen("/tmp/ow_out.gcode", "rb");
        if (!gf) { record_error(*session, "gcode export produced no output"); return -8; }

        std::fseek(gf, 0, SEEK_END);
        long sz = std::ftell(gf);
        std::rewind(gf);

        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz) + 1));
        if (!buf) {
            std::fclose(gf);
            record_error(*session, "out of memory");
            return -9;
        }
        std::fread(buf, 1, static_cast<std::size_t>(sz), gf);
        std::fclose(gf);
        buf[sz] = '\0';

        *out_gcode = buf;
        *out_len   = static_cast<int>(sz);
        return 0;

    } catch (const std::exception& e) {
        record_error(*session, e.what());
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
    g_conversion_last_error.clear();
    if (!obj_data || obj_len <= 0 || !out_stl || !out_len) return -1;

    {
        FILE* f = std::fopen("/tmp/ow_in.obj", "wb");
        if (!f) { record_error("cannot open /tmp/ow_in.obj for writing"); return -3; }
        std::size_t written = std::fwrite(obj_data, 1, static_cast<std::size_t>(obj_len), f);
        std::fclose(f);
        if (written != static_cast<std::size_t>(obj_len)) {
            std::remove("/tmp/ow_in.obj");
            record_error("failed to write complete OBJ data to MEMFS");
            return -3;
        }
    }

    int status = -9;
    try {
        Slic3r::Model model;
        Slic3r::ObjInfo obj_info;
        std::string message;
        if (!Slic3r::load_obj("/tmp/ow_in.obj", &model, obj_info, message, "object")) {
            record_error(message.empty() ? "OBJ load failed" : message);
            status = -4;
        } else if (model.objects.empty()) {
            record_error("OBJ contains no geometry");
            status = -5;
        } else {
            // Merge all volumes from all objects into one mesh
            Slic3r::TriangleMesh combined;
            for (auto* obj : model.objects)
                for (auto* vol : obj->volumes)
                    combined.merge(vol->mesh());

            if (combined.facets_count() == 0) {
                record_error("OBJ contains no printable geometry");
                status = -5;
            } else if (!Slic3r::store_stl("/tmp/ow_out.stl", &combined, true)) {
                record_error("STL export failed");
                status = -8;
            } else {
                FILE* sf = std::fopen("/tmp/ow_out.stl", "rb");
                if (!sf) {
                    record_error("STL export produced no output");
                    status = -8;
                } else {
                    std::fseek(sf, 0, SEEK_END);
                    long sz = std::ftell(sf);
                    std::rewind(sf);
                    if (sz <= 0) {
                        std::fclose(sf);
                        record_error("STL export produced empty output");
                        status = -8;
                    } else {
                        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz)));
                        if (!buf) {
                            std::fclose(sf);
                            record_error("out of memory");
                            status = -9;
                        } else {
                            std::size_t nread = std::fread(buf, 1, static_cast<std::size_t>(sz), sf);
                            std::fclose(sf);
                            if (nread != static_cast<std::size_t>(sz)) {
                                std::free(buf);
                                record_error("STL read incomplete");
                                status = -8;
                            } else {
                                *out_stl = buf;
                                *out_len = static_cast<int>(sz);
                                status = 0;
                            }
                        }
                    }
                }
            }
        }
    } catch (const std::exception& e) {
        record_error(e.what());
        status = -9;
    }

    // Always clean up MEMFS temp files to avoid heap leaks in long-running sessions
    std::remove("/tmp/ow_in.obj");
    std::remove("/tmp/ow_out.stl");
    return status;
}

/**
 * Slice multiple STL files arranged on a single plate.
 *
 * all_stl      concatenation of all STL file bytes
 * offsets      int32 pairs [start0, len0, start1, len1, …] — one per file
 * n_files      number of files (= offsets length / 2)
 * extruder_ids nullable int32 array of length n_files — 1-based "extruder"
 *              override per object (0 = inherit the config's default),
 *              forwarded to OrcaSlicer's per-object `extruder` config key
 *              (PrintConfig.cpp: coInt, min 0 = inherit; normalize_fdm()
 *              resolves it to the per-region *_filament_id fields). This is
 *              the classic single-nozzle multi-material path — different
 *              objects on one plate printed with different filament slots —
 *              and does NOT touch nozzle_diameter/support_different_extruders(),
 *              so it stays clear of the still-unresolved multi-nozzle crash
 *              documented on isMultiExtruderProfile() in src/lib/profiles.ts.
 *              Ignored (no-op) when null, so existing single-extruder callers
 *              are unaffected.
 *
 * Error codes: same convention as orc_slice.
 */
EMSCRIPTEN_KEEPALIVE
int orc_slice_multi(
    void* session_ptr,
    const void* all_stl, int all_stl_len,
    const int* offsets, int n_files,
    const int* extruder_ids,
    char** out_gcode, int* out_len)
{
    OrcSession* session = as_session(session_ptr);
    if (!session) return -1;
    session->last_error.clear();
    if (!session->initialized) { record_error(*session, "call orc_init first"); return -1; }
    if (!all_stl || all_stl_len <= 0 || !offsets || n_files <= 0 || !out_gcode || !out_len)
        return -1;

    const char* base = static_cast<const char*>(all_stl);

    try {
        Slic3r::Model model;

        // ── load each STL segment into the shared model ───────────────────────
        for (int i = 0; i < n_files; i++) {
            const int start = offsets[i * 2];
            const int len   = offsets[i * 2 + 1];
            if (start < 0 || len <= 0 || start + len > all_stl_len) {
                record_error(*session, "invalid offset table");
                return -1;
            }
            const std::string path = "/tmp/ow_multi_" + std::to_string(i) + ".stl";
            {
                FILE* f = std::fopen(path.c_str(), "wb");
                if (!f) { record_error(*session, "cannot write temp STL"); return -3; }
                std::fwrite(base + start, 1, static_cast<std::size_t>(len), f);
                std::fclose(f);
            }
            const std::string name = "object_" + std::to_string(i);
            const bool ok = Slic3r::load_stl(path.c_str(), &model, name.c_str());
            std::remove(path.c_str());
            if (!ok) {
                record_error(*session, "STL load failed for file " + std::to_string(i));
                return -4;
            }
        }

        if (model.objects.empty()) { record_error(*session, "no objects loaded"); return -5; }

        // Per-object extruder override requires an exact 1:1 file→object
        // correspondence (true for the common case of one watertight solid
        // per STL). If any file expanded into more than one object, skip the
        // mapping entirely rather than guess a wrong association.
        const bool can_map_extruders =
            extruder_ids != nullptr && model.objects.size() == static_cast<std::size_t>(n_files);

        // ── centre each mesh; give each one an instance; optional extruder override ──
        for (std::size_t i = 0; i < model.objects.size(); i++) {
            auto* obj = model.objects[i];
            center_object_xy_only(obj);
            if (obj->instances.empty())
                obj->add_instance();
            if (can_map_extruders && extruder_ids[i] > 0) {
                obj->config.set("extruder", extruder_ids[i]);
            }
        }

        // ── auto-arrange on the bed ───────────────────────────────────────
        // coord_t uses 1 µm resolution: 1 mm = 1,000,000 units.
        // For circular beds the arrangement boundary is the largest axis-aligned
        // square inscribed in the circle (half-side = radius / √2) so objects are
        // never placed in the rectangle corners that fall outside the printable area.
        const double half_w = (session->bed_shape == "circle")
            ? session->bed_cx / std::sqrt(2.0)
            : session->bed_cx;
        const double half_h = (session->bed_shape == "circle")
            ? session->bed_cy / std::sqrt(2.0)
            : session->bed_cy;
        const Slic3r::BoundingBox bed(
            Slic3r::Point(
                static_cast<coord_t>((session->bed_cx - half_w) * 1e6),
                static_cast<coord_t>((session->bed_cy - half_h) * 1e6)
            ),
            Slic3r::Point(
                static_cast<coord_t>((session->bed_cx + half_w) * 1e6),
                static_cast<coord_t>((session->bed_cy + half_h) * 1e6)
            )
        );

        Slic3r::ArrangeParams params;
        params.min_obj_distance = static_cast<coord_t>(2.0 * 1e6); // 2 mm gap
        params.parallel         = false; // WASM is single-threaded

        // Objects that don't fit land at bed centre instead of throwing
        Slic3r::arrange_objects(model, bed, params,
            [session](Slic3r::arrangement::ArrangePolygon& ap) {
                ap.translation = Slic3r::Vec2crd(
                    static_cast<coord_t>(session->bed_cx * 1e6),
                    static_cast<coord_t>(session->bed_cy * 1e6)
                );
            });

        // ── configure & slice ─────────────────────────────────────────────
        Slic3r::Print print;
        print.apply(model, session->config);
        set_is_bbl_printer(print, session->config);

        {
            Slic3r::StringObjectException err = print.validate();
            if (!err.string.empty()) { record_error(*session, err.string); return -6; }
        }

        try {
            print.process();
        } catch (const Slic3r::SlicingError& e) {
            record_error(*session, e.what());
            return -7;
        }

        TempFileGuard out_guard("/tmp/ow_out.gcode");
        {
            Slic3r::GCode gcode_gen;
            gcode_gen.do_export(&print, "/tmp/ow_out.gcode", nullptr, nullptr);
        }

        FILE* gf = std::fopen("/tmp/ow_out.gcode", "rb");
        if (!gf) { record_error(*session, "gcode export produced no output"); return -8; }

        std::fseek(gf, 0, SEEK_END);
        long sz = std::ftell(gf);
        std::rewind(gf);

        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz) + 1));
        if (!buf) {
            std::fclose(gf);
            record_error(*session, "out of memory");
            return -9;
        }
        std::fread(buf, 1, static_cast<std::size_t>(sz), gf);
        std::fclose(gf);
        buf[sz] = '\0';

        *out_gcode = buf;
        *out_len   = static_cast<int>(sz);
        return 0;

    } catch (const std::exception& e) {
        record_error(*session, e.what());
        return -9;
    }
}

/**
 * Convert a STEP file to binary STL using OrcaSlicer's OCCT reader.
 *
 * Only STEP is supported: OrcaSlicer's load_step() uses STEPCAFControl_Reader,
 * which does not read IGES.  (.iges/.igs are not routed here by the frontend.)
 *
 * Arguments:
 *   cad_data / cad_len  — raw STEP file bytes
 *   out_stl / out_len   — on success: malloc'd binary STL buffer + byte length
 *                         Caller must free with orc_free().
 *
 * Error codes (same conventions as orc_obj_to_stl):
 *   -1  invalid arguments
 *   -3  could not write STEP data to MEMFS
 *   -4  STEP load failed (bad file / unsupported feature)
 *   -5  file contains no printable geometry
 *   -8  STL export failed
 *   -9  unexpected C++ exception
 */
EMSCRIPTEN_KEEPALIVE
int orc_cad_to_stl(const char* cad_data, int cad_len,
                   char** out_stl, int* out_len) {
    g_conversion_last_error.clear();
    if (!cad_data || cad_len <= 0 || !out_stl || !out_len) return -1;

    const char* tmp_in  = "/tmp/ow_in.step";
    const char* tmp_out = "/tmp/ow_cad_out.stl";

    {
        FILE* f = std::fopen(tmp_in, "wb");
        if (!f) { record_error("cannot open CAD temp file for writing"); return -3; }
        std::size_t written = std::fwrite(cad_data, 1, static_cast<std::size_t>(cad_len), f);
        std::fclose(f);
        if (written != static_cast<std::size_t>(cad_len)) {
            std::remove(tmp_in);
            record_error("failed to write complete CAD data to MEMFS");
            return -3;
        }
    }

    int status = -9;
    try {
        Slic3r::Model model;
        try {
            // OrcaSlicer has no free load_step(); read_from_step is the real
            // entry point (it runs Step::load + Step::mesh under the hood and
            // throws Slic3r::RuntimeError on load/mesh failure).
            model = Slic3r::Model::read_from_step(
                tmp_in,
                Slic3r::LoadStrategy::AddDefaultInstances,
                nullptr,   // ImportStepProgressFn — progress callback
                nullptr,   // StepIsUtf8Fn — encoding probe
                nullptr,   // per-shape mesh callback
                0.003,     // linear deflection  (OrcaSlicer default)
                0.5,       // angular deflection (OrcaSlicer default)
                false);    // split compound
        } catch (const std::exception& e) {
            record_error(std::string("STEP load failed: ") + e.what());
            std::remove(tmp_in);
            std::remove(tmp_out);
            return -4;
        }

        if (model.objects.empty()) {
            record_error("STEP file contains no geometry");
            status = -5;
        } else {
            Slic3r::TriangleMesh combined;
            for (auto* obj : model.objects)
                for (auto* vol : obj->volumes)
                    combined.merge(vol->mesh());

            if (combined.facets_count() == 0) {
                record_error("CAD file contains no printable geometry");
                status = -5;
            } else if (!Slic3r::store_stl(tmp_out, &combined, true)) {
                record_error("STL export of CAD geometry failed");
                status = -8;
            } else {
                FILE* sf = std::fopen(tmp_out, "rb");
                if (!sf) {
                    record_error("STL export produced no output");
                    status = -8;
                } else {
                    std::fseek(sf, 0, SEEK_END);
                    long sz = std::ftell(sf);
                    std::rewind(sf);
                    if (sz <= 0) {
                        std::fclose(sf);
                        record_error("STL export produced empty output");
                        status = -8;
                    } else {
                        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz)));
                        if (!buf) {
                            std::fclose(sf);
                            record_error("out of memory");
                            status = -9;
                        } else {
                            std::size_t nread = std::fread(buf, 1, static_cast<std::size_t>(sz), sf);
                            std::fclose(sf);
                            if (nread != static_cast<std::size_t>(sz)) {
                                std::free(buf);
                                record_error("STL read incomplete");
                                status = -8;
                            } else {
                                *out_stl = buf;
                                *out_len = static_cast<int>(sz);
                                status = 0;
                            }
                        }
                    }
                }
            }
        }
    } catch (const std::exception& e) {
        record_error(e.what());
        status = -9;
    }

    std::remove(tmp_in);
    std::remove(tmp_out);
    return status;
}

/**
 * Export a single mesh + the session's current config as a .3mf file
 * (geometry + embedded OrcaSlicer settings — no plate/G-code/thumbnail data;
 * see orca-wasm bridge design notes for why that's out of scope here).
 *
 * On success *out_3mf points to a malloc'd buffer containing the .3mf (a ZIP
 * archive — contains embedded NUL bytes, so callers must use the returned
 * length, never a NUL-terminated string read). Caller must free with
 * orc_free().
 *
 * Error codes: same convention as orc_slice, with -8 meaning the 3MF export
 * itself (store_bbs_3mf) failed rather than gcode export.
 */
EMSCRIPTEN_KEEPALIVE
int orc_write_3mf(void* session_ptr, const void* stl_data, int stl_len,
                  char** out_3mf, int* out_len) {
    OrcSession* session = as_session(session_ptr);
    if (!session) return -1;
    session->last_error.clear();
    if (!session->initialized) { record_error(*session, "call orc_init first"); return -1; }
    if (!stl_data || stl_len <= 0 || !out_3mf || !out_len)
        return -1;

    try {
        // Guard covers the fwrite below too: if load_stl throws (rather than
        // just returning false), the temp file would otherwise never be
        // removed — a real per-failed-export MEMFS leak since MEMFS is
        // RAM-backed (same rationale as TempFileGuard's other use below).
        TempFileGuard in_guard("/tmp/ow_3mf_in.stl");
        {
            FILE* f = std::fopen("/tmp/ow_3mf_in.stl", "wb");
            if (!f) { record_error(*session, "cannot open /tmp/ow_3mf_in.stl for writing"); return -3; }
            std::size_t written = std::fwrite(stl_data, 1, static_cast<std::size_t>(stl_len), f);
            std::fclose(f);
            if (written != static_cast<std::size_t>(stl_len)) {
                record_error(*session, "failed to write complete STL data to MEMFS");
                return -3;
            }
        }

        Slic3r::Model model;
        const bool stl_ok = Slic3r::load_stl("/tmp/ow_3mf_in.stl", &model, "object");
        if (!stl_ok) {
            record_error(*session, "STL load failed");
            return -4;
        }
        if (model.objects.empty()) {
            record_error(*session, "model contains no objects");
            return -5;
        }

        // Same placement convention as orc_slice, so the mesh lands back in
        // the same spot on re-import instead of at the model-space origin.
        for (auto* obj : model.objects) {
            center_object_xy_only(obj);
            if (obj->instances.empty()) {
                auto* inst = obj->add_instance();
                inst->set_offset(Slic3r::Vec3d(session->bed_cx, session->bed_cy, 0.0));
            }
        }

        TempFileGuard out_guard("/tmp/ow_out.3mf");
        {
            Slic3r::StoreParams store_params;
            store_params.path = "/tmp/ow_out.3mf";
            store_params.model = &model;
            store_params.config = &session->config;
            // plate_data_list / project_presets / thumbnail_* all stay at
            // their StoreParams defaults (empty) — this headless bridge has
            // no PartPlateList, so there's no plate/gcode/thumbnail data to
            // attach. store_bbs_3mf treats all of that as optional and still
            // writes a valid model+config 3mf (verified by reading its
            // implementation: every plate/thumbnail loop is bounded by
            // plate_data_list.size(), which is 0 here).
            bool ok = Slic3r::store_bbs_3mf(store_params);
            // get_backup_path() (used internally for the "Auxiliaries" dir)
            // lazily creates a per-export MEMFS scratch directory the first
            // time it's touched; nothing else in this bridge ever cleans it
            // up, so without this call every export leaks one empty
            // directory tree into MEMFS for the life of the WASM instance.
            model.remove_backup_path_if_exist();
            if (!ok) {
                record_error(*session, "3MF export failed");
                return -8;
            }
        }

        FILE* zf = std::fopen("/tmp/ow_out.3mf", "rb");
        if (!zf) { record_error(*session, "3mf export produced no output"); return -8; }

        std::fseek(zf, 0, SEEK_END);
        long sz = std::ftell(zf);
        std::rewind(zf);
        if (sz <= 0) {
            std::fclose(zf);
            record_error(*session, "3mf export produced empty output");
            return -8;
        }

        char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz)));
        if (!buf) {
            std::fclose(zf);
            record_error(*session, "out of memory");
            return -9;
        }
        std::size_t nread = std::fread(buf, 1, static_cast<std::size_t>(sz), zf);
        std::fclose(zf);
        if (nread != static_cast<std::size_t>(sz)) {
            std::free(buf);
            record_error(*session, "3mf read incomplete");
            return -8;
        }

        *out_3mf = buf;
        *out_len = static_cast<int>(sz);
        return 0;

    } catch (const std::exception& e) {
        record_error(*session, e.what());
        return -9;
    }
}

/** Free a buffer returned by orc_slice, orc_slice_multi, orc_obj_to_stl, orc_cad_to_stl, or orc_write_3mf. */
EMSCRIPTEN_KEEPALIVE
void orc_free(void* ptr) {
    std::free(ptr);
}

/**
 * Return the last error message as a null-terminated string.
 * The pointer is valid until the next orc_* call on the same session (or,
 * for a null session, the next orc_obj_to_stl / orc_cad_to_stl call).
 *
 * Pass the session used for the failing orc_init / orc_slice / orc_slice_multi
 * call. Pass 0/null after a failing orc_obj_to_stl / orc_cad_to_stl call
 * (those take no session) — this is also why the parameter used to be
 * documented as "unused" and JS always passed literal 0: that call pattern
 * still works unchanged for conversion errors.
 */
EMSCRIPTEN_KEEPALIVE
const char* orc_decode_exception(void* session_ptr) {
    OrcSession* session = as_session(session_ptr);
    return session ? session->last_error.c_str() : g_conversion_last_error.c_str();
}

} // extern "C"
