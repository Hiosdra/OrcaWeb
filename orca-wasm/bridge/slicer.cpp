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
 *   orc_read_3mf(mf, mfLen, outStl, outStlLen,
 *                outConfigJson, outConfigLen)                     → 0 = ok
 *   orc_free(ptr)
 *   orc_decode_exception(session)                                 → null-terminated UTF-8 string
 *
 * orc_obj_to_stl / orc_cad_to_stl / orc_read_3mf are pure format conversions
 * — they never touch slicer config state, so they take no session handle.
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
 *
 * orc_read_3mf reuses the same -1/-3/-4/-5/-8/-9 meanings (input write /
 * 3MF load / no geometry / STL export / exception), decoded via
 * orc_decode_exception(0) like orc_obj_to_stl / orc_cad_to_stl.
 */

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <stdexcept>
#include <memory>
#include <mutex>
#include <new>
#include <sys/stat.h>

#include <emscripten.h>

// OrcaSlicer core
// (note: an earlier attempt to cap oneTBB via tbb::global_control lived here;
// it deadlocked — see wasm/CMakeLists.txt's PTHREAD_POOL_SIZE comment and
// orca-wasm/MT-PLAN.md. The pool is sized to hardware_concurrency instead.)
#include "libslic3r/libslic3r.h"
#include "libslic3r/Model.hpp"
#include "libslic3r/ModelArrange.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Slicing.hpp"
#include "libslic3r/Preset.hpp"
#include "libslic3r/Format/STL.hpp"
#include "libslic3r/Format/OBJ.hpp"
#include "libslic3r/Format/STEP.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/GCode.hpp"
#include "libslic3r/GCode/WipeTower.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/Semver.hpp"

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
    // Opt-in override of the engine's mixed-nozzle-temperature guard, matching
    // desktop OrcaSlicer's "Remove mixed temperature restriction" preference.
    // Off by default (the guard exists to prevent nozzle clogging / damage);
    // when set, orc_slice / orc_slice_multi call
    // Print::set_check_multi_filaments_compatibility(false) before validate().
    // See issue #164.
    bool remove_mixed_temp_restriction = false;
    // Variable (adaptive) layer height, matching desktop OrcaSlicer's Adaptive
    // tool: when on, orc_slice / orc_slice_multi compute a per-object layer
    // height profile from the mesh geometry (layer_height_profile_adaptive)
    // before slicing, so detailed regions get thinner layers and flat regions
    // thicker ones. Off by default (a fixed layer height is the engine default
    // and what every preset expects). Not native engine config keys — read
    // here as pseudo-keys (like bed_size_* above) and applied in
    // apply_adaptive_layer_height(). See issue #138.
    bool  adaptive_layer_height = false;
    // Quality/speed factor forwarded verbatim to layer_height_profile_adaptive
    // (0..1, engine's own range; desktop's slider default is 0.5). Lower =
    // finer detail (thinner layers, smaller cusp error); higher = faster
    // (thicker layers).
    float adaptive_layer_height_quality = 0.5f;
};

// Slicing blocks the worker's event loop. MAIN_THREAD_EM_ASM delivers this
// from both the single-threaded engine and a pthread back to that worker,
// where postMessage reaches the browser's main thread immediately.
static void post_slice_progress(int percent, const std::string& stage) {
    MAIN_THREAD_EM_ASM({
        // The build smoke test also runs this bridge in Node, where there is
        // no Worker parent to receive browser UI messages.
        if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
            self.postMessage({ type: 'SLICE_PROGRESS', percent: $0, stage: UTF8ToString($1) });
        }
    }, percent, stage.c_str());
}

struct ProgressState {
    int last_percent = -1;
    std::string last_stage;
    double last_update_ms = -100.0;
    std::mutex mutex;
};

static void attach_progress_callback(Slic3r::Print& print) {
    auto state = std::make_shared<ProgressState>();

    print.set_status_callback([state](const Slic3r::PrintBase::SlicingStatus& status) {
        if (status.percent < 0)
            return;

        const double now = emscripten_get_now();
        std::lock_guard<std::mutex> lock(state->mutex);
        const int percent = std::max(state->last_percent, std::min(status.percent, 100));
        const bool should_emit =
            status.text != state->last_stage
            || (percent == 100 && state->last_percent != 100)
            || (percent != state->last_percent && now - state->last_update_ms >= 100.0);
        if (should_emit) {
            state->last_percent = percent;
            state->last_stage = status.text;
            state->last_update_ms = now;
            post_slice_progress(percent, status.text);
        }
    });
}

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

// Same rationale as TempFileGuard, for Model::remove_backup_path_if_exist()
// (the lazily-created MEMFS "Auxiliaries"/backup scratch dir that
// store_bbs_3mf/load_bbs_3mf both touch internally via get_backup_path()).
// Traced the two most likely internal throw sites in bbs_3mf.cpp — a
// painting-feature version mismatch during model XML parsing, and a
// malformed Metadata/*.config JSON — and both are caught internally and
// converted to false/-1 returns rather than propagating, so the risk this
// guards against is low in practice. bbs_3mf.cpp is ~9000 lines and wasn't
// exhaustively audited past those two paths, though, and this costs
// nothing, so guard it the same way as everything else here rather than
// rely on that audit staying true across future engine version bumps.
struct ModelBackupPathGuard {
    Slic3r::Model& model;
    explicit ModelBackupPathGuard(Slic3r::Model& m) : model(m) {}
    ~ModelBackupPathGuard() { model.remove_backup_path_if_exist(); }
    ModelBackupPathGuard(const ModelBackupPathGuard&) = delete;
    ModelBackupPathGuard& operator=(const ModelBackupPathGuard&) = delete;
};

// load_bbs_3mf() transfers ownership of imported plate data and embedded
// presets to its output vectors. Keep both behind one guard so partial loads
// and exceptions release the same allocations as OrcaSlicer's GUI callers.
struct Loaded3mfResourcesGuard {
    Slic3r::PlateDataPtrs& plate_data;
    std::vector<Slic3r::Preset*>& project_presets;

    Loaded3mfResourcesGuard(Slic3r::PlateDataPtrs& plates, std::vector<Slic3r::Preset*>& presets)
        : plate_data(plates), project_presets(presets) {}
    ~Loaded3mfResourcesGuard() {
        Slic3r::release_PlateData_list(plate_data);
        for (Slic3r::Preset* preset : project_presets)
            delete preset;
        project_presets.clear();
    }
    Loaded3mfResourcesGuard(const Loaded3mfResourcesGuard&) = delete;
    Loaded3mfResourcesGuard& operator=(const Loaded3mfResourcesGuard&) = delete;
};

// Reads an entire file into a malloc'd buffer. Returns nullptr on any
// failure (missing file, empty/negative size, OOM, or a short read); sets
// *out_err to a short reason and *out_oom to distinguish the OOM case
// (callers map that to a different error code than the others). Callers
// still pick their own record_error() overload (session-aware vs. the
// conversion-functions' shared slot) and error code, since those differ
// per call site — this only owns the mechanical fopen/fseek/malloc/fread
// sequence that orc_write_3mf and orc_read_3mf both need to read back the
// file they just asked OrcaSlicer to produce.
static char* read_file_to_buffer(const char* path, long* out_len, const char** out_err, bool* out_oom) {
    *out_oom = false;
    FILE* f = std::fopen(path, "rb");
    if (!f) { *out_err = "produced no output"; return nullptr; }
    std::fseek(f, 0, SEEK_END);
    long sz = std::ftell(f);
    std::rewind(f);
    if (sz <= 0) {
        std::fclose(f);
        *out_err = "produced empty output";
        return nullptr;
    }
    char* buf = static_cast<char*>(std::malloc(static_cast<std::size_t>(sz)));
    if (!buf) {
        std::fclose(f);
        *out_err = "out of memory";
        *out_oom = true;
        return nullptr;
    }
    std::size_t nread = std::fread(buf, 1, static_cast<std::size_t>(sz), f);
    std::fclose(f);
    if (nread != static_cast<std::size_t>(sz)) {
        std::free(buf);
        *out_err = "read incomplete";
        return nullptr;
    }
    *out_len = sz;
    return buf;
}

// ── helpers ───────────────────────────────────────────────────────────────────
static std::string json_val_to_string(const nlohmann::json& v) {
    if (v.is_string())  return v.get<std::string>();
    if (v.is_boolean()) return v.get<bool>() ? "1" : "0";
    if (v.is_number())  return std::to_string(v.get<double>());
    return "";
}

// Read a pseudo-key boolean flag out of the config JSON (the bridge's own
// keys — remove_mixed_temp_restriction, adaptive_layer_height — that never
// reach the engine config). Accepts a JSON bool, a number (non-zero = true),
// or the "1"/"true" strings the JS config layer serializes booleans as;
// anything else (including a missing key) yields `dflt`.
static bool json_flag(const nlohmann::json& j, const char* key, bool dflt = false) {
    if (!j.contains(key)) return dflt;
    const auto& v = j[key];
    if (v.is_boolean()) return v.get<bool>();
    if (v.is_number())  return v.get<double>() != 0.0;
    if (v.is_string())  { const std::string s = v.get<std::string>(); return s == "1" || s == "true"; }
    return dflt;
}

/**
 * Serialize a JSON array into the single string OrcaSlicer's deserializer
 * expects for that specific option — the separator is a property of the
 * option's *type*, not a universal comma:
 *
 *   coStrings       ';' plus c-style quoting/escaping (escape_strings_cstyle)
 *   coPointsGroups  '#' between groups, ',' between points inside one group
 *   everything else ','
 *
 * Getting this wrong silently fuses N values into 1 rather than failing, which
 * is exactly how a real multi-nozzle profile used to die: a Bambu Lab H2D
 * stores two per-extruder printable areas and two filament colours, both of
 * which collapsed to a single entry. The engine then had nozzle_diameter of
 * length 2 but length-1 companions, and indexed them by extruder id — blowing
 * up in Brim.cpp's outer_inner_brim_area() and ToolOrdering's flush-matrix
 * lookup (issue #140).
 *
 * The separator is looked up in the engine's own option registry rather than
 * mirrored in a hand-maintained list on the JS side, so it cannot drift out of
 * sync with the engine version this bridge is compiled against. Strings go
 * through escape_strings_cstyle() rather than a plain join because several
 * coStrings options (filament_start_gcode and friends) legitimately contain
 * ';' and newlines, which a raw join would corrupt.
 */
static std::string json_array_to_config_string(const std::string& key, const nlohmann::json& arr) {
    std::vector<std::string> parts;
    parts.reserve(arr.size());
    for (const auto& el : arr) {
        if (el.is_null()) continue;
        parts.push_back(json_val_to_string(el));
    }
    if (parts.empty()) return "";

    const Slic3r::ConfigOptionDef* def = Slic3r::print_config_def.get(key);
    const Slic3r::ConfigOptionType type = def ? def->type : Slic3r::coNone;
    if (type == Slic3r::coStrings)
        return Slic3r::escape_strings_cstyle(parts);

    const char sep = (type == Slic3r::coPointsGroups) ? '#' : ',';
    std::string out;
    for (std::size_t i = 0; i < parts.size(); ++i) {
        if (i) out += sep;
        out += parts[i];
    }
    return out;
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

// Print::m_origin (the plate offset, read via get_plate_origin()) has no
// default member initializer either, and Vec3d is an Eigen type whose default
// constructor leaves its components uninitialized. Only the desktop GUI's
// PartPlate code ever calls set_plate_origin(), so in this headless bridge it
// stays garbage — and PrintInstance::shift_without_plate_offset() (Print.cpp)
// subtracts it from every instance shift:
//     return shift - Point(scaled(plate_offset.x()), scaled(plate_offset.y()));
// Brim.cpp's append_and_translate() then translates the brim/no-brim polygons
// by that value and hands them to Clipper, which rejects anything beyond its
// coordinate range ("Coordinate outside allowed range"). Because the garbage
// depends on whatever happens to be on the stack, this reproduced only for
// some meshes and flipped with unrelated code changes — the synthetic
// icosphere in smoke-test.mjs started failing purely because an unrelated
// bridge edit shifted the binary layout. Zero it explicitly, exactly like
// set_is_bbl_printer() below does for the other uninitialised Print member.
static void zero_plate_origin(Slic3r::Print& print) {
    print.set_plate_origin(Slic3r::Vec3d::Zero());
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

// Compute a per-object adaptive layer height profile and store it on each
// object, matching what desktop OrcaSlicer's "Adaptive" button does before a
// slice (GLCanvas3D::LayersEditing::adaptive_layer_height_profile). Must run
// after print.apply() — that's what populates each PrintObject's slicing
// parameters (update_slicing_parameters), and layer_height_profile_adaptive
// needs them — but before print.process(), which reads the profile back off
// the model object (PrintObject::update_layer_height_profile, via slice()).
//
// The profile is set on print.objects()' model objects, which are the copies
// Print owns after apply() (Print::apply → m_model.assign_copy), so this is
// the same object process() later reads. Using the PrintObject's own
// slicing_parameters() guarantees the profile's Z samples line up exactly with
// what update_layer_height_profile validates against, so it is not discarded.
// objects_mutable() hands back non-const PrintObject*, so model_object()
// resolves to the non-const overload (PrintObjectBase has both) — no cast
// needed to write the profile, unlike desktop's GLCanvas3D path where the
// object is genuinely held as const ModelObject*.
static void apply_adaptive_layer_height(Slic3r::Print& print, float quality_factor) {
    for (Slic3r::PrintObject* obj : print.objects_mutable()) {
        const Slic3r::SlicingParameters& sp = obj->slicing_parameters();
        if (!sp.valid) continue;
        Slic3r::ModelObject* model_object = obj->model_object();
        std::vector<double> profile = Slic3r::layer_height_profile_adaptive(sp, *model_object, quality_factor);
        model_object->layer_height_profile.set(std::move(profile));
    }
}

// Place the prime (wipe) tower the way desktop OrcaSlicer does. Its
// PartPlateList::set_default_wipe_tower_pos_for_plate — default anchor, size
// estimate, then clamp into the plate — lives in the GUI and never runs
// headless, so without this a slice uses the raw PrintConfig position (15, 220)
// unchanged: fine on a ~256 mm bed, but off the back edge of a smaller one (a
// 210 mm Prusa MK4) and, on a larger one (a 350 mm Voron), a different spot
// than desktop picks. This ports that routine: anchor at the desktop default,
// estimate the footprint from the loaded model's height — which the JS config
// layer cannot, running before any mesh exists and with a height-driven depth —
// and clamp. The result matches what desktop computes from the same config.
// The multi-material config that turns the tower on is built in
// withPrimeTowerAddressing()/multiFilamentPassthrough() in src/lib/profiles.ts
// (#163); this is the placement half that has to live where the mesh does.
static void clamp_wipe_tower_to_bed(Slic3r::DynamicPrintConfig& config,
                                    const Slic3r::Model& model,
                                    double bed_x, double bed_y) {
    const auto* enable = config.option<Slic3r::ConfigOptionBool>("enable_prime_tower");
    if (!enable || !enable->value) return;

    // With fewer than two filaments there is no tool change to purge, so the
    // engine builds no tower and there is nothing to place.
    const auto* colours = config.option<Slic3r::ConfigOptionStrings>("filament_colour");
    const int filaments = colours ? static_cast<int>(colours->values.size()) : 1;
    if (filaments < 2) return;

    const auto* nozzles = config.option<Slic3r::ConfigOptionFloats>("nozzle_diameter");
    const int nozzle_count = (nozzles && !nozzles->values.empty())
        ? static_cast<int>(nozzles->values.size()) : 1;

    // Tallest object drives the tower's height-based minimum depth.
    double max_height = 0.0;
    for (const auto* obj : model.objects)
        max_height = std::max(max_height, obj->bounding_box_exact().size().z());

    auto opt_float = [&](const char* key, double dflt) -> double {
        const auto* o = config.option(key);
        return o ? o->getFloat() : dflt;
    };

    // Replicate PartPlate::estimate_wipe_tower_size for the default rib wall:
    // the footprint is a square of side `depth`, and prime_tower_width does not
    // enter it. One term is dropped: desktop adds a per-change filament-change
    // volume for a 2-nozzle machine, which would slightly enlarge `depth` there.
    // Omitting it only matters if a dual-nozzle machine slices on a bed shallow
    // enough to clamp, and those ship deep beds (an H2D is 320 mm) where the
    // tower never reaches the edge — so the simpler estimate is safe in practice.
    const double layer_height  = opt_float("layer_height", 0.2);
    const double wipe_volume   = opt_float("prime_volume", 45.0);
    const double extra_spacing = opt_float("prime_tower_infill_gap", 150.0) / 100.0;
    double       rib_width     = opt_float("wipe_tower_rib_width", 8.0);
    const double extra_rib_len = opt_float("wipe_tower_extra_rib_length", 0.0);

    const double volume = wipe_volume * (nozzle_count == 2 ? filaments : (filaments - 1));
    double depth = std::sqrt(volume / layer_height * extra_spacing);
    const double min_depth = Slic3r::WipeTower::get_limit_depth_by_height(static_cast<float>(max_height));
    const double volume_depth = depth;
    depth = std::max(min_depth, depth);
    rib_width = std::min(rib_width, depth / 2.0);
    // `max(depth + extra_rib_len, volume_depth)` always resolves to the first
    // operand here — `depth` is already >= volume_depth from the max() above and
    // extra_rib_len is non-negative. It is kept verbatim (rather than reduced to
    // `depth + extra_rib_len`) to mirror desktop's estimate_wipe_tower_size line
    // for line, so a future re-sync against upstream diffs cleanly.
    depth = rib_width / std::sqrt(2.0) + std::max(depth + extra_rib_len, volume_depth);
    const double size = depth; // rib tower footprint is square

    double brim = opt_float("prime_tower_brim_width", 3.0);
    if (brim < 0) brim = Slic3r::WipeTower::get_auto_brim_by_height(static_cast<float>(max_height));
    const double margin = WIPE_TOWER_MARGIN + brim;

    // Desktop OrcaSlicer's default tower position (set_default_wipe_tower_pos_
    // for_plate): a top-left-ish anchor, or the i3/bed-slinger variant. The raw
    // PrintConfig default (15, 220) is deliberately NOT used as the start — it
    // is only an unplaced fallback, and since the tower is new here (#163) there
    // is no prior placement to preserve. Our profiles never carry
    // printer_structure (it stays psUndefine), so this resolves to the CoreXY
    // anchor for every printer — exactly what desktop computes from the same
    // config, so a bed the tower already fits (a 350 mm Voron) lands it in the
    // same spot desktop would rather than a different-but-valid corner.
    double x = 165.0; // WIPE_TOWER_DEFAULT_X_POS
    double y = 250.0; // WIPE_TOWER_DEFAULT_Y_POS
    const auto* structure = config.option<Slic3r::ConfigOptionEnum<Slic3r::PrinterStructure>>("printer_structure");
    if (structure && structure->value == Slic3r::psI3) {
        x = 0.0;   // I3_WIPE_TOWER_DEFAULT_X_POS
        y = 250.0; // I3_WIPE_TOWER_DEFAULT_Y_POS
    }

    // Clamp into the plate, in plate-local coordinates (the bridge zeroes the
    // plate origin, so the bed is [0,bed_x] x [0,bed_y]). Same if/else-if shape
    // as set_default_wipe_tower_pos_for_plate: prefer clamping down from the far
    // edge, only lift off the near edge when it wasn't already past the far one.
    if (x + margin + size > bed_x) x = bed_x - size - margin;
    else if (x < margin)           x = margin;
    if (y + margin + size > bed_y) y = bed_y - size - margin;
    else if (y < margin)           y = margin;
    // A tower wider than the bed itself can't be satisfied; keep the origin on
    // the bed rather than hand the engine a negative coordinate.
    if (x < 0) x = 0;
    if (y < 0) y = 0;

    config.option<Slic3r::ConfigOptionFloats>("wipe_tower_x", true)->values = { x };
    config.option<Slic3r::ConfigOptionFloats>("wipe_tower_y", true)->values = { y };
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

        // Opt-in override of the mixed-nozzle-temperature guard (issue #164),
        // matching desktop's "Remove mixed temperature restriction". Not a
        // native engine config key — read here as a pseudo-key (like bed_size_*
        // above) and applied via Print::set_check_multi_filaments_compatibility
        // before validate() in the slice functions.
        session->remove_mixed_temp_restriction = json_flag(j, "remove_mixed_temp_restriction");

        // Variable (adaptive) layer height (issue #138), matching desktop's
        // Adaptive tool. Pseudo-keys like the two above — not native engine
        // config options — applied to the model's layer_height_profile in
        // apply_adaptive_layer_height() rather than through the config.
        {
            session->adaptive_layer_height = json_flag(j, "adaptive_layer_height");
            session->adaptive_layer_height_quality = 0.5f;
            if (j.contains("adaptive_layer_height_quality")) {
                const auto& v = j["adaptive_layer_height_quality"];
                double q = 0.5;
                if (v.is_number())
                    q = v.get<double>();
                else if (v.is_string()) {
                    try { q = std::stod(v.get<std::string>()); } catch (...) { q = 0.5; }
                }
                // Clamp to the engine's expected 0..1 range; next_layer_height()
                // lerps against it and an out-of-range value would extrapolate
                // past min/max layer height.
                session->adaptive_layer_height_quality = static_cast<float>(std::min(1.0, std::max(0.0, q)));
            }
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
            // Arrays carry multi-value options (per-extruder / per-filament);
            // the separator depends on the option's type — see
            // json_array_to_config_string().
            std::string sv = val.is_array() ? json_array_to_config_string(key, val)
                                            : json_val_to_string(val);
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
        zero_plate_origin(print);
        set_is_bbl_printer(print, session->config);
        // When the user opts in (issue #164), turn off the engine's
        // mixed-nozzle-temperature guard so a single-nozzle AMS plate with
        // filaments whose recommended ranges don't overlap (e.g. PLA + PETG)
        // slices instead of failing validation. The incompatible-temperature
        // case then surfaces through validate()'s `warning` out-param (below)
        // rather than as a fatal error.
        if (session->remove_mixed_temp_restriction)
            print.set_check_multi_filaments_compatibility(false);
        // Variable (adaptive) layer height (issue #138) — compute after apply()
        // (slicing parameters are populated), before validate()/process().
        if (session->adaptive_layer_height)
            apply_adaptive_layer_height(print, session->adaptive_layer_height_quality);
        attach_progress_callback(print);

        {
            // Print::validate() returns a StringObjectException whose
            // `string` member holds the error message ("" when valid). The
            // `warning` out-param catches the non-fatal mixed-temperature
            // notice raised once the guard above is disabled — without a
            // non-null pointer to absorb it, validate() would still return
            // that notice as a fatal error. It is intentionally ignored.
            Slic3r::StringObjectException warning;
            Slic3r::StringObjectException err = print.validate(&warning);
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
 *              resolves it to the per-region *_filament_id fields). Names a
 *              *filament* slot, not a nozzle: whether two slots share one
 *              nozzle (AMS-style) or drive genuine T0/T1 tool changes is
 *              decided by `filament_map` in the config, which the frontend
 *              builds in withFilamentSlots() (src/lib/profiles.ts). Real
 *              multi-nozzle profiles work here as of #160 — the crash this
 *              used to be gated against was our own array serialization, see
 *              json_array_to_config_string() above.
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
        // See orca-wasm/MT-PLAN.md / bridge/CMakeLists.txt's SLIC3R_WASM_MT
        // option — the only threading-aware line in the entire bridge.
        // Everything else runs in parallel automatically via real oneTBB
        // (built from source in CI) once that option is set; the sequential
        // build (default) is unaffected.
#ifdef SLIC3R_WASM_MT
        params.parallel         = true;
#else
        params.parallel         = false; // WASM is single-threaded
#endif

        // Objects that don't fit land at bed centre instead of throwing
        Slic3r::arrange_objects(model, bed, params,
            [session](Slic3r::arrangement::ArrangePolygon& ap) {
                ap.translation = Slic3r::Vec2crd(
                    static_cast<coord_t>(session->bed_cx * 1e6),
                    static_cast<coord_t>(session->bed_cy * 1e6)
                );
            });

        // ── configure & slice ─────────────────────────────────────────────
        // Fit the prime tower onto the bed before applying the config — the
        // model is loaded and arranged now, so its height is known (see
        // clamp_wipe_tower_to_bed). bed_cx/cy are half-extents.
        clamp_wipe_tower_to_bed(session->config, model, 2.0 * session->bed_cx, 2.0 * session->bed_cy);
        Slic3r::Print print;
        print.apply(model, session->config);
        zero_plate_origin(print);
        set_is_bbl_printer(print, session->config);
        // See orc_slice: opt-in override of the mixed-nozzle-temperature guard
        // for single-nozzle multi-material plates (issue #164).
        if (session->remove_mixed_temp_restriction)
            print.set_check_multi_filaments_compatibility(false);
        // Variable (adaptive) layer height (issue #138); see orc_slice. With a
        // multi-object plate the engine requires all objects share the same
        // layering when a prime tower is on (Print::validate), so an adaptive
        // multi-material plate with a tower surfaces that as a -6 validation
        // error rather than silently ignoring the setting.
        if (session->adaptive_layer_height)
            apply_adaptive_layer_height(print, session->adaptive_layer_height_quality);
        attach_progress_callback(print);

        {
            // `warning` absorbs the non-fatal mixed-temperature notice when the
            // guard above is off; see orc_slice for why the pointer is required.
            Slic3r::StringObjectException warning;
            Slic3r::StringObjectException err = print.validate(&warning);
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
            // Constructed before store_bbs_3mf() runs, so its destructor
            // (which does the get_backup_path()/"Auxiliaries" dir cleanup
            // that call lazily triggers) still fires even if store_bbs_3mf
            // throws instead of returning false.
            ModelBackupPathGuard backup_guard(model);

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
            if (!ok) {
                record_error(*session, "3MF export failed");
                return -8;
            }
        }

        long sz = 0;
        const char* err = nullptr;
        bool oom = false;
        char* buf = read_file_to_buffer("/tmp/ow_out.3mf", &sz, &err, &oom);
        if (!buf) {
            record_error(*session, std::string("3mf export ") + err);
            return oom ? -9 : -8;
        }

        *out_3mf = buf;
        *out_len = static_cast<int>(sz);
        return 0;

    } catch (const std::exception& e) {
        record_error(*session, e.what());
        return -9;
    }
}

/**
 * Read a .3mf file's mesh + embedded OrcaSlicer config, using OrcaSlicer's
 * own reader (load_bbs_3mf) rather than the JS-side XML walker
 * (src/lib/parse3mf.ts) — so this understands whatever OrcaSlicer itself
 * wrote (multi-object assemblies, per-object transforms) exactly the way
 * OrcaSlicer does, instead of re-deriving the 3MF core spec's transform math
 * in JS. A pure format conversion like orc_obj_to_stl / orc_cad_to_stl — no
 * session/config state involved, so it takes none.
 *
 * On success:
 *   *out_stl points to a malloc'd binary STL buffer — all objects' meshes,
 *     each with its own instance/volume transforms already applied via
 *     ModelObject::mesh() (so position/rotation/scale in the file survive),
 *     merged into one. Byte length in *out_stl_len.
 *   *out_config_json points to a malloc'd, null-terminated JSON object
 *     string of every config key the file's Metadata/*.config had *set*
 *     (same string-valued shape OrcaSlicer's own .config files use — the JS
 *     side re-parses it with the existing parseOrcaProfileJson(), the same
 *     parser already used for imported profile JSON). Byte length in
 *     *out_config_len (excludes the trailing NUL, matching orc_slice's
 *     gcode convention; JSON text itself never contains an embedded NUL).
 * Caller must free both buffers with orc_free().
 *
 * Error codes: same convention as orc_obj_to_stl.
 *   -3  could not write 3MF bytes to MEMFS
 *   -4  3MF load failed (bad archive / no recognizable model)
 *   -5  3MF contains no printable geometry
 *   -8  STL export of the merged mesh failed
 *   -9  unexpected C++ exception
 */
EMSCRIPTEN_KEEPALIVE
int orc_read_3mf(const void* mf_data, int mf_len,
                 char** out_stl, int* out_stl_len,
                 char** out_config_json, int* out_config_len) {
    g_conversion_last_error.clear();
    if (!mf_data || mf_len <= 0 || !out_stl || !out_stl_len || !out_config_json || !out_config_len)
        return -1;

    const char* tmp_in = "/tmp/ow_3mf_read_in.3mf";
    {
        FILE* f = std::fopen(tmp_in, "wb");
        if (!f) { record_error("cannot open temp file for writing"); return -3; }
        std::size_t written = std::fwrite(mf_data, 1, static_cast<std::size_t>(mf_len), f);
        std::fclose(f);
        if (written != static_cast<std::size_t>(mf_len)) {
            std::remove(tmp_in);
            record_error("failed to write complete 3MF data to MEMFS");
            return -3;
        }
    }

    try {
        TempFileGuard in_guard(tmp_in);

        Slic3r::Model model;
        // Constructed before load_bbs_3mf() runs, so its destructor (the
        // get_backup_path()/"Auxiliaries" dir cleanup that call lazily
        // triggers) still fires even if load_bbs_3mf throws instead of
        // returning false — same rationale as orc_write_3mf's backup_guard.
        ModelBackupPathGuard backup_guard(model);
        Slic3r::DynamicPrintConfig config;
        // EnableSilent: substitute unknown/incompatible option values with
        // defaults instead of throwing — mirrors orc_init's own "silently
        // skip unknown / incompatible keys" policy for the same reason (a
        // 3MF authored by a different OrcaSlicer/Bambu Studio version may
        // carry option values this pinned engine version doesn't recognize).
        Slic3r::ConfigSubstitutionContext substitutions(Slic3r::ForwardCompatibilitySubstitutionRule::EnableSilent);
        Slic3r::PlateDataPtrs plate_data_list;
        std::vector<Slic3r::Preset*> project_presets;
        Loaded3mfResourcesGuard loaded_resources(plate_data_list, project_presets);
        Slic3r::Semver file_version;

        bool ok = Slic3r::load_bbs_3mf(
            tmp_in, &config, &substitutions, &model,
            &plate_data_list, &project_presets,
            nullptr, nullptr, &file_version, nullptr,
            Slic3r::LoadStrategy::AddDefaultInstances | Slic3r::LoadStrategy::LoadModel | Slic3r::LoadStrategy::LoadConfig);

        if (!ok) {
            record_error("3MF load failed");
            return -4;
        }
        if (model.objects.empty()) {
            record_error("3MF contains no geometry");
            return -5;
        }

        // ModelObject::mesh() bakes in every instance's + volume's transform
        // (position/rotation/scale) — unlike orc_obj_to_stl/orc_cad_to_stl's
        // raw vol->mesh() merge, which is fine for OBJ/STEP (no separate
        // instance concept there) but would silently drop a 3MF's actual
        // placement if used here.
        Slic3r::TriangleMesh combined;
        for (auto* obj : model.objects) {
            if (!obj) continue;
            combined.merge(obj->mesh());
        }
        if (combined.facets_count() == 0) {
            record_error("3MF contains no printable geometry");
            return -5;
        }

        const char* tmp_out = "/tmp/ow_3mf_read_out.stl";
        TempFileGuard out_guard(tmp_out);
        if (!Slic3r::store_stl(tmp_out, &combined, true)) {
            record_error("STL export of 3MF geometry failed");
            return -8;
        }

        long stl_sz = 0;
        const char* stl_err = nullptr;
        bool stl_oom = false;
        char* stl_buf = read_file_to_buffer(tmp_out, &stl_sz, &stl_err, &stl_oom);
        if (!stl_buf) {
            record_error(std::string("STL export ") + stl_err);
            return stl_oom ? -9 : -8;
        }
        std::unique_ptr<char, decltype(&std::free)> stl_owner(stl_buf, &std::free);
        int stl_len = static_cast<int>(stl_sz);

        // Serialize every config key the file actually had set — matches
        // OrcaSlicer's own flat .config shape (string values), which
        // parseOrcaProfileJson() on the JS side already knows how to read.
        nlohmann::json j = nlohmann::json::object();
        for (const auto& key : config.keys()) {
            const Slic3r::ConfigOption* opt = config.option(key);
            if (opt) j[key] = opt->serialize();
        }
        std::string json_str = j.dump();

        char* json_buf = static_cast<char*>(std::malloc(json_str.size() + 1));
        if (!json_buf) {
            record_error("out of memory");
            return -9;
        }
        std::memcpy(json_buf, json_str.data(), json_str.size());
        json_buf[json_str.size()] = '\0';

        *out_stl = stl_owner.release();
        *out_stl_len = stl_len;
        *out_config_json = json_buf;
        *out_config_len = static_cast<int>(json_str.size());
        return 0;

    } catch (const std::exception& e) {
        record_error(e.what());
        return -9;
    }
}

/** Free a buffer returned by orc_slice, orc_slice_multi, orc_obj_to_stl, orc_cad_to_stl, orc_write_3mf, or orc_read_3mf. */
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
