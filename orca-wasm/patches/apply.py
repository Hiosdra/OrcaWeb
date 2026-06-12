#!/usr/bin/env python3
"""
Apply WASM compatibility changes to the OrcaSlicer source tree.

Uses regex-based substitution rather than line-number-anchored diffs so the
patches stay valid across minor version bumps.  Run from orca-wasm/ with:

    python3 patches/apply.py [--check]

--check  dry-run: print what would change without writing files.
"""

import re
import sys
import argparse
from pathlib import Path

ORCA = Path(__file__).resolve().parent.parent / "orca"
DRY_RUN = False


def patch(rel_path: str, replacements: list[tuple[str, str, int]]) -> bool:
    """
    Apply a list of (pattern, replacement, expected_count) tuples to a file.
    expected_count == 0 means the match is optional (already applied or absent).
    Returns True if the file was (or would be) modified.
    """
    path = ORCA / rel_path
    if not path.exists():
        print(f"  SKIP (not found): {rel_path}")
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    original = text
    for pattern, replacement, expected in replacements:
        n = len(re.findall(pattern, text, re.MULTILINE | re.DOTALL))
        if expected > 0 and n == 0:
            print(f"  WARN pattern not found in {rel_path}: {pattern[:60]!r}")
        text = re.sub(pattern, replacement, text, flags=re.MULTILINE | re.DOTALL)
    if text == original:
        print(f"  OK (no change): {rel_path}")
        return False
    if DRY_RUN:
        print(f"  WOULD PATCH: {rel_path}")
        return True
    path.write_text(text, encoding="utf-8")
    print(f"  PATCHED: {rel_path}")
    return True


# ─────────────────────────────────────────────────────────────────────────────
# 1. Root CMakeLists.txt — add SLIC3R_WASM option; make heavy deps conditional
# ─────────────────────────────────────────────────────────────────────────────
patch("CMakeLists.txt", [
    # Add SLIC3R_WASM option near the top (after project() line)
    (
        r'(project\s*\(\s*OrcaSlicer[^)]*\))',
        r'\1\n\noption(SLIC3R_WASM "Build for WebAssembly with Emscripten" OFF)',
        1,
    ),
    # NOTE: find_package(TBB) is intentionally NOT guarded for WASM — our
    # FindTBB.cmake shim (in CMAKE_MODULE_PATH) creates the TBB::tbb interface
    # target pointing to wasm/shims/, which is required by clipper/libnest2d.
    # Skip wxWidgets & OpenGL in WASM mode
    (
        r'(find_package\s*\(\s*wxWidgets\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
    # Guard the main slicer executable against WASM builds
    (
        r'(add_subdirectory\s*\(\s*src\s*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()\nif(SLIC3R_WASM)\n  add_subdirectory(src)\nendif()',
        0,
    ),
    # Downgrade CMP0167 to OLD so the legacy FindBoost.cmake (module mode) is
    # used.  Our Boost is built with b2 which does not install BoostConfig.cmake;
    # config-mode detection (CMP0167 NEW) would fail on a b2-built Boost.
    (
        r'cmake_policy\s*\(\s*SET\s+CMP0167\s+NEW\s*\)',
        r'cmake_policy(SET CMP0167 OLD)',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 2. src/CMakeLists.txt — skip GUI subdirectory in WASM builds
# ─────────────────────────────────────────────────────────────────────────────
patch("src/CMakeLists.txt", [
    # Guard the GUI/app subdirectory (name varies: GUI, slic3r, OrcaSlicer, bambu_studio)
    (
        r'(add_subdirectory\s*\(\s*(?:GUI|slic3r|OrcaSlicer|bambu_studio)\s*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
    # libnoise is a GUI/texture dep not needed for headless WASM slicing
    (
        r'(find_package\s*\(\s*libnoise\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 3. src/libslic3r/Format/STEP.hpp — guard entire file body in WASM mode
#    Model.hpp includes STEP.hpp unconditionally.  STEP.hpp uses OCCT types
#    throughout (TopoDS_Shape, Handle, Message_ProgressIndicator, etc.) — not
#    just in the includes.  Wrap everything after #pragma once with
#    #ifndef SLIC3R_NO_OCCT.  The load_step() stub in STEP.cpp doesn't need
#    the header in WASM mode.
# ─────────────────────────────────────────────────────────────────────────────
step_hpp = ORCA / "src/libslic3r/Format/STEP.hpp"
if step_hpp.exists():
    _content = step_hpp.read_text(encoding="utf-8", errors="replace")
    if "#ifndef SLIC3R_NO_OCCT" not in _content:
        # STEP.hpp uses a traditional include guard ending with #endif /* ... */ (not //).
        # Step 1: insert #ifndef SLIC3R_NO_OCCT right after the #define guard line.
        _patched = re.sub(
            r'(#define\s+\S+\s*\n)',
            r'\1#ifndef SLIC3R_NO_OCCT\n',
            _content,
            count=1,
        )
        # Step 2: close the guard before the final #endif (handles // and /* */ comments).
        last = _patched.rfind('#endif')
        if last >= 0 and _patched != _content:
            _patched = _patched[:last] + '#endif // SLIC3R_NO_OCCT\n' + _patched[last:]
            if not DRY_RUN:
                step_hpp.write_text(_patched, encoding="utf-8")
            print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Format/STEP.hpp")
        else:
            print(f"  WARN pattern not matched: src/libslic3r/Format/STEP.hpp")
    else:
        print("  OK (no change): src/libslic3r/Format/STEP.hpp")

# ─────────────────────────────────────────────────────────────────────────────
# 3b. src/libslic3r/Model.hpp — guard read_from_step() declaration
#     Model.hpp declares read_from_step() which uses ImportStepProgressFn,
#     StepIsUtf8Fn, and Slic3r::Step — all defined in STEP.hpp inside the
#     SLIC3R_NO_OCCT guard.  Guard the method declaration to match.
# ─────────────────────────────────────────────────────────────────────────────
patch("src/libslic3r/Model.hpp", [
    (
        r'(static\s+Model\s+read_from_step\s*\([^;]+;)',
        r'#ifndef SLIC3R_NO_OCCT\n\1\n#endif // SLIC3R_NO_OCCT',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 3d. src/libslic3r/Model.cpp — guard read_from_step() definition
#     The declaration in Model.hpp is already guarded (section 3b).
#     The definition also uses ImportStepProgressFn / StepIsUtf8Fn / Slic3r::Step
#     which are hidden when SLIC3R_NO_OCCT is set.  Use brace-counting to wrap
#     the whole function body without touching any other Model functions.
# ─────────────────────────────────────────────────────────────────────────────
_model_cpp = ORCA / "src/libslic3r/Model.cpp"
if _model_cpp.exists():
    _mc = _model_cpp.read_text(encoding="utf-8", errors="replace")
    if "#ifndef SLIC3R_NO_OCCT" not in _mc:
        _m = re.search(r'\nModel Model::read_from_step\s*\(', _mc)
        if _m:
            _func_start = _m.start() + 1          # skip leading \n
            _brace_start = _mc.index('{', _func_start)
            _depth = 0
            _func_end = _brace_start
            for _i in range(_brace_start, len(_mc)):
                _ch = _mc[_i]
                if _ch == '{':
                    _depth += 1
                elif _ch == '}':
                    _depth -= 1
                    if _depth == 0:
                        _func_end = _i + 1
                        break
            _guarded = (
                "#ifndef SLIC3R_NO_OCCT\n"
                + _mc[_func_start:_func_end]
                + "\n#endif // SLIC3R_NO_OCCT\n"
            )
            _mc_new = _mc[:_func_start] + _guarded + _mc[_func_end:]
            if not DRY_RUN:
                _model_cpp.write_text(_mc_new, encoding="utf-8")
            print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Model.cpp (read_from_step guard)")
        else:
            print("  WARN: Model::read_from_step not found in Model.cpp")
    else:
        print("  OK (no change): src/libslic3r/Model.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 3c. src/libslic3r/GCode.hpp — fix narrowing in LayerResult::make_nop_layer_result
#     On 32-bit WASM, size_t is uint32_t.  std::numeric_limits<coord_t>::max()
#     = INT64_MAX which cannot be narrowed to size_t → [-Wc++11-narrowing] error.
#     Replace with static_cast<size_t>(-1) (= SIZE_MAX on any platform).
# ─────────────────────────────────────────────────────────────────────────────
patch("src/libslic3r/GCode.hpp", [
    (
        r'(\{"",\s*)std::numeric_limits<coord_t>::max\(\)',
        r'\1static_cast<size_t>(-1)',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 4. src/libslic3r/CMakeLists.txt — make OCCT / OpenCV / draco conditional
# ─────────────────────────────────────────────────────────────────────────────
patch("src/libslic3r/CMakeLists.txt", [
    # Add SLIC3R_WASM compile definitions
    (
        r'(target_compile_definitions\s*\(\s*libslic3r\s+PUBLIC)',
        r'\1\n  $<$<BOOL:${SLIC3R_WASM}>:SLIC3R_WASM;SLIC3R_NO_OCCT;SLIC3R_NO_OPENVDB;SLIC3R_NO_OPENCV>',
        1,
    ),
    # Wrap OpenCASCADE find / link
    (
        r'(find_package\s*\(\s*OpenCASCADE\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
    # Wrap OCCT_LIBS in target_link_libraries
    (
        r'(\$\{OCCT_LIBS\})',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:\1>',
        0,
    ),
    # Wrap OpenCV link
    (
        r'(opencv_world)',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:opencv_world>',
        0,
    ),
    # Wrap draco find / link
    (
        r'(find_package\s*\(\s*draco\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
    (
        r'(draco::draco)',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:draco::draco>',
        0,
    ),
    # Wrap OpenVDB link
    (
        r'(OpenVDB::openvdb)',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:OpenVDB::openvdb>',
        0,
    ),
    # Wrap JPEG find / link — JPEG thumbnails not needed for WASM slicing
    (
        r'(find_package\s*\(\s*JPEG\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
    (
        r'(JPEG::JPEG)',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:JPEG::JPEG>',
        0,
    ),
    # Freetype is linked for non-WIN32 (emscripten is non-WIN32, so guard it)
    (
        r'(if\s*\(\s*NOT\s+WIN32\s*\)\s*\n\s*)(target_link_libraries\s*\(\s*libslic3r\s+PRIVATE\s+\$\{FREETYPE_LIBRARIES\}\s*\))',
        r'if(NOT WIN32 AND NOT SLIC3R_WASM)\n    \2',
        0,
    ),
    # fontconfig (Linux non-WASM only)
    (
        r'(target_link_libraries\s*\(\s*libslic3r\s+PRIVATE\s+fontconfig\s*\))',
        r'if(NOT SLIC3R_WASM)\n    \1\nendif()',
        0,
    ),
    # noise::noise (libnoise) — guarded find_package above; also guard the link
    (
        r'\bnoise::noise\b',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:noise::noise>',
        0,
    ),
    # encoding_check() is a CMake function (defined in dev-utils/) that creates
    # a custom target running the encoding-check binary against sources.
    # Emscripten compiles that binary to .js; the build system then tries to
    # execute it natively → "Permission denied" (exit 126).
    # Guard the call so the utility target is never created in WASM mode.
    (
        r'(encoding_check\s*\([^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
])

# Note: GCode.cpp uses tbb::parallel_pipeline for layer generation — this IS
# the critical G-code export path.  Our tbb/parallel_pipeline.h shim implements
# a correct sequential version, so no source-level guarding is needed here.

# ─────────────────────────────────────────────────────────────────────────────
# 4a. src/libslic3r/AABBTreeLines.hpp — Eigen template deduction fix
# ─────────────────────────────────────────────────────────────────────────────
patch("src/libslic3r/AABBTreeLines.hpp", [
    # Template deduction for distance_to_squared fails because
    # origin.cast<Scalar>() returns a lazy CwiseUnaryOp that:
    #   (a) does not match Eigen::Matrix in deduction, and
    #   (b) even after .eval(), preserves Options from the source (e.g. 2=DontAlign)
    #       while Vec<N,Scalar> defaults to Options=0, causing "match 2 against 0" error.
    # Fix: explicitly construct using decltype(nearest_point) — that IS the concrete
    # Vec<Dim<LineType>, Scalar> type, so deduction succeeds and Options are forced to 0.
    # Eigen's Matrix(const MatrixBase<OtherDerived>&) ctor handles the conversion.
    (
        r'(distance_to_squared\(line,\s*)(origin\.template cast<typename LineType::Scalar>\(\))(?:\.eval\(\))?',
        r'\1decltype(nearest_point)(\2)',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 4b. src/libslic3r/Feature/FuzzySkin/FuzzySkin.cpp — stub for WASM
#     In v2.3.2 the file moved to Feature/FuzzySkin/.  It uses libnoise and
#     thread_local which are unavailable in the WASM build.  Wrap the entire
#     original content with #ifndef SLIC3R_WASM and provide no-op stubs.
# ─────────────────────────────────────────────────────────────────────────────
FUZZY_SKIN_STUB = """\
#ifdef SLIC3R_WASM
// libnoise and thread_local not available in WASM; provide no-op stubs.
#include "FuzzySkin.hpp"
namespace Slic3r::Feature::FuzzySkin {
void fuzzy_polyline(Points&, bool, coordf_t, const FuzzySkinConfig&) {}
void fuzzy_extrusion_line(Arachne::ExtrusionJunctions&, coordf_t, const FuzzySkinConfig&, bool) {}
void group_region_by_fuzzify(PerimeterGenerator&) {}
bool should_fuzzify(const FuzzySkinConfig&, int, size_t, bool) { return false; }
Polygon apply_fuzzy_skin(const Polygon& p, const PerimeterGenerator&, size_t, bool) { return p; }
void    apply_fuzzy_skin(Arachne::ExtrusionLine*, const PerimeterGenerator&, bool) {}
} // namespace Slic3r::Feature::FuzzySkin
#else
"""

fuzzy_cpp = ORCA / "src/libslic3r/Feature/FuzzySkin/FuzzySkin.cpp"
if fuzzy_cpp.exists():
    _fc = fuzzy_cpp.read_text(encoding="utf-8", errors="replace")
    if "#ifdef SLIC3R_WASM" not in _fc:
        if not DRY_RUN:
            fuzzy_cpp.write_text(FUZZY_SKIN_STUB + _fc + "\n#endif // SLIC3R_WASM\n", encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Feature/FuzzySkin/FuzzySkin.cpp")
    else:
        print("  OK (no change): src/libslic3r/Feature/FuzzySkin/FuzzySkin.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 5. Format/STEP.cpp — stub body when SLIC3R_NO_OCCT
# ─────────────────────────────────────────────────────────────────────────────
STEP_STUB = """\
#ifdef SLIC3R_NO_OCCT
// OCCT not available in WASM — provide empty stubs.
#include "STEP.hpp"
#include "libslic3r/Exception.hpp"
namespace Slic3r {
bool load_step(const char*, Model*) {
    throw RuntimeError("STEP import is not available in the browser build.");
}
} // namespace Slic3r
#else
"""

step_cpp = ORCA / "src/libslic3r/Format/STEP.cpp"
if step_cpp.exists():
    content = step_cpp.read_text(encoding="utf-8")
    if "#ifdef SLIC3R_NO_OCCT" not in content:
        if not DRY_RUN:
            step_cpp.write_text(STEP_STUB + content + "\n#endif // SLIC3R_NO_OCCT\n",
                                encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Format/STEP.cpp")
    else:
        print("  OK (no change): src/libslic3r/Format/STEP.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6. OpenVDBUtils.cpp — stub body when SLIC3R_NO_OPENVDB
# ─────────────────────────────────────────────────────────────────────────────
ovdb_cpp = ORCA / "src/libslic3r/OpenVDBUtils.cpp"
if ovdb_cpp.exists():
    content = ovdb_cpp.read_text(encoding="utf-8")
    if "#ifdef SLIC3R_NO_OPENVDB" not in content:
        stub = "#ifdef SLIC3R_NO_OPENVDB\n// OpenVDB disabled for WASM\n#else\n"
        if not DRY_RUN:
            ovdb_cpp.write_text(stub + content + "\n#endif // SLIC3R_NO_OPENVDB\n",
                                encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/OpenVDBUtils.cpp")
    else:
        print("  OK (no change): src/libslic3r/OpenVDBUtils.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6a. OpenVDBUtils.hpp — guard whole body when SLIC3R_NO_OPENVDB
#     The header declares functions returning openvdb types (FloatGrid, Vec3s).
#     OpenVDBUtils.cpp is only compiled when the OpenVDB::openvdb target exists
#     (absent in WASM), but Hollowing.cpp includes this header unconditionally.
#     Guard everything after the include-guard #define so it is a no-op in WASM.
# ─────────────────────────────────────────────────────────────────────────────
_ovdb_hpp = ORCA / "src/libslic3r/OpenVDBUtils.hpp"
if _ovdb_hpp.exists():
    _oh = _ovdb_hpp.read_text(encoding="utf-8", errors="replace")
    if "#ifndef SLIC3R_NO_OPENVDB" not in _oh:
        _patched = re.sub(
            r'(#define\s+OPENVDBUTILS_HPP\s*\n)',
            r'\1#ifndef SLIC3R_NO_OPENVDB\n',
            _oh,
            count=1,
        )
        _last = _patched.rfind('#endif')
        if _last >= 0 and _patched != _oh:
            _patched = _patched[:_last] + '#endif // SLIC3R_NO_OPENVDB\n' + _patched[_last:]
            if not DRY_RUN:
                _ovdb_hpp.write_text(_patched, encoding="utf-8")
            print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/OpenVDBUtils.hpp")
        else:
            print("  WARN pattern not matched: src/libslic3r/OpenVDBUtils.hpp")
    else:
        print("  OK (no change): src/libslic3r/OpenVDBUtils.hpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6a-2. SLA/Hollowing.cpp — stub when SLIC3R_NO_OPENVDB
#     Hollowing is OpenVDB-based (Interior holds openvdb::FloatGrid::Ptr).
#     SLA hollowing is irrelevant to the FDM WASM slicer; provide no-op stubs
#     for every non-inline function declared in Hollowing.hpp.
# ─────────────────────────────────────────────────────────────────────────────
HOLLOWING_STUB = """\
#ifdef SLIC3R_NO_OPENVDB
// OpenVDB not available in WASM — SLA mesh hollowing is disabled.
#include "Hollowing.hpp"
#include <libslic3r/ExPolygon.hpp>
#include <array>
#include <functional>
#include <utility>
#include <vector>
namespace Slic3r { namespace sla {

struct Interior { indexed_triangle_set mesh; };
void InteriorDeleter::operator()(Interior *p) { delete p; }
indexed_triangle_set &      get_mesh(Interior &i)       { return i.mesh; }
const indexed_triangle_set &get_mesh(const Interior &i) { return i.mesh; }

bool DrainHole::operator==(const DrainHole &sp) const {
    return pos.isApprox(sp.pos) && normal.isApprox(sp.normal) &&
           radius == sp.radius && height == sp.height && failed == sp.failed;
}
bool DrainHole::is_inside(const Vec3f &) const { return false; }
bool DrainHole::get_intersections(const Vec3f &, const Vec3f &,
                                  std::array<std::pair<float, Vec3d>, 2> &) const { return false; }
indexed_triangle_set DrainHole::to_mesh() const { return {}; }

InteriorPtr generate_interior(const TriangleMesh &, const HollowingConfig &, const JobController &) { return {}; }
void hollow_mesh(TriangleMesh &, const HollowingConfig &, int) {}
void hollow_mesh(TriangleMesh &, const Interior &, int) {}
void remove_inside_triangles(TriangleMesh &, const Interior &, const std::vector<bool> &) {}
double get_distance(const Vec3f &, const Interior &) { return 0.; }
void cut_drainholes(std::vector<ExPolygons> &, const std::vector<float> &, float,
                    const sla::DrainHoles &, std::function<void(void)>) {}

}} // namespace Slic3r::sla
#else
"""

hollowing_cpp = ORCA / "src/libslic3r/SLA/Hollowing.cpp"
if hollowing_cpp.exists():
    content = hollowing_cpp.read_text(encoding="utf-8", errors="replace")
    if "#ifdef SLIC3R_NO_OPENVDB" not in content:
        if not DRY_RUN:
            hollowing_cpp.write_text(HOLLOWING_STUB + content + "\n#endif // SLIC3R_NO_OPENVDB\n",
                                     encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/SLA/Hollowing.cpp")
    else:
        print("  OK (no change): src/libslic3r/SLA/Hollowing.cpp")
else:
    print("  SKIP (not found): src/libslic3r/SLA/Hollowing.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6b. Format/DRC.cpp — stub body when SLIC3R_WASM
#     DRC (Google Draco) compression is not available in WASM builds.
# ─────────────────────────────────────────────────────────────────────────────
DRC_STUB = """\
#ifdef SLIC3R_WASM
// Google Draco not available in WASM — provide no-op stubs.
#include "DRC.hpp"
namespace Slic3r {
bool load_drc(const char*, TriangleMesh*) { return false; }
bool load_drc(const char*, Model*, const char*) { return false; }
bool store_drc(const TriangleMesh&, const char*, int, int) { return false; }
bool store_drc(const ModelObject&, const char*, int, int) { return false; }
bool store_drc(const Model&, const char*, int, int) { return false; }
} // namespace Slic3r
#else
"""

drc_cpp = ORCA / "src/libslic3r/Format/DRC.cpp"
if drc_cpp.exists():
    content = drc_cpp.read_text(encoding="utf-8")
    if "#ifdef SLIC3R_WASM" not in content:
        if not DRY_RUN:
            drc_cpp.write_text(DRC_STUB + content + "\n#endif // SLIC3R_WASM\n",
                               encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Format/DRC.cpp")
    else:
        print("  OK (no change): src/libslic3r/Format/DRC.cpp")
else:
    print("  SKIP (not found): src/libslic3r/Format/DRC.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6c. Format/svg.cpp — stub body when SLIC3R_NO_OCCT
#     svg.cpp uses OCCT (BRepBuilderAPI_MakeWire etc.) for SVG-to-mesh import.
# ─────────────────────────────────────────────────────────────────────────────
svg_cpp = ORCA / "src/libslic3r/Format/svg.cpp"
if svg_cpp.exists():
    content = svg_cpp.read_text(encoding="utf-8")
    if "#ifdef SLIC3R_NO_OCCT" not in content:
        stub = (
            "#ifdef SLIC3R_NO_OCCT\n"
            "// OCCT not available in WASM — provide a no-op stub.\n"
            "#include \"svg.hpp\"\n"
            "namespace Slic3r {\n"
            "bool load_svg(const char*, Model*, std::string&) { return false; }\n"
            "} // namespace Slic3r\n"
            "#else\n"
        )
        if not DRY_RUN:
            svg_cpp.write_text(stub + content + "\n#endif // SLIC3R_NO_OCCT\n",
                               encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Format/svg.cpp")
    else:
        print("  OK (no change): src/libslic3r/Format/svg.cpp")
else:
    print("  SKIP (not found): src/libslic3r/Format/svg.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6c-2. Shape/TextShape.cpp — stub body when SLIC3R_NO_OCCT
#     TextShape.cpp uses OCCT (Standard_TypeDef.hxx etc.) for text-to-mesh.
#     Provide no-op stubs for its three public functions in WASM mode.
# ─────────────────────────────────────────────────────────────────────────────
textshape_cpp = ORCA / "src/libslic3r/Shape/TextShape.cpp"
if textshape_cpp.exists():
    content = textshape_cpp.read_text(encoding="utf-8", errors="replace")
    if "#ifdef SLIC3R_NO_OCCT" not in content:
        stub = (
            "#ifdef SLIC3R_NO_OCCT\n"
            "// OCCT not available in WASM — provide no-op stubs.\n"
            "#include \"TextShape.hpp\"\n"
            "#include <map>\n"
            "#include <string>\n"
            "#include <vector>\n"
            "namespace Slic3r {\n"
            "std::vector<std::string> init_occt_fonts() { return {}; }\n"
            "void load_text_shape(const char*, const char*, const float, const float, bool, bool, TextResult&) {}\n"
            "std::map<std::string, std::string> get_occt_fonts_maps() { return {}; }\n"
            "} // namespace Slic3r\n"
            "#else\n"
        )
        if not DRY_RUN:
            textshape_cpp.write_text(stub + content + "\n#endif // SLIC3R_NO_OCCT\n",
                                     encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Shape/TextShape.cpp")
    else:
        print("  OK (no change): src/libslic3r/Shape/TextShape.cpp")
else:
    print("  SKIP (not found): src/libslic3r/Shape/TextShape.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6e. src/libslic3r/ObjColorUtils.hpp — guard OpenCV include
#     ObjColorUtils.hpp includes <opencv2/opencv.hpp> unconditionally.
#     OpenCV is unavailable in WASM; wrap everything after #pragma once with
#     #ifndef SLIC3R_NO_OPENCV so the header becomes a no-op in WASM mode.
# ─────────────────────────────────────────────────────────────────────────────
_obj_color_hpp = ORCA / "src/libslic3r/ObjColorUtils.hpp"
if _obj_color_hpp.exists():
    _oc = _obj_color_hpp.read_text(encoding="utf-8", errors="replace")
    if "#ifndef SLIC3R_NO_OPENCV" not in _oc:
        # Find end of #pragma once line and insert guard after it
        _pragma_end = _oc.find('\n', _oc.index('#pragma once')) + 1
        _patched = (
            _oc[:_pragma_end]
            + "#ifndef SLIC3R_NO_OPENCV\n"
            + _oc[_pragma_end:]
            + "\n#endif // SLIC3R_NO_OPENCV\n"
        )
        if not DRY_RUN:
            _obj_color_hpp.write_text(_patched, encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/ObjColorUtils.hpp")
    else:
        print("  OK (no change): src/libslic3r/ObjColorUtils.hpp")
else:
    print("  SKIP (not found): src/libslic3r/ObjColorUtils.hpp")

# 6e-2. src/libslic3r/ObjColorUtils.cpp — stub when SLIC3R_NO_OPENCV
_obj_color_cpp = ORCA / "src/libslic3r/ObjColorUtils.cpp"
if _obj_color_cpp.exists():
    _occ = _obj_color_cpp.read_text(encoding="utf-8", errors="replace")
    if "#ifdef SLIC3R_NO_OPENCV" not in _occ:
        stub = "#ifdef SLIC3R_NO_OPENCV\n// OpenCV not available in WASM.\n#else\n"
        if not DRY_RUN:
            _obj_color_cpp.write_text(stub + _occ + "\n#endif // SLIC3R_NO_OPENCV\n", encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/ObjColorUtils.cpp")
    else:
        print("  OK (no change): src/libslic3r/ObjColorUtils.cpp")
else:
    print("  SKIP (not found): src/libslic3r/ObjColorUtils.cpp")

# ─────────────────────────────────────────────────────────────────────────────
# 6f. src/libslic3r/Platform.cpp — suppress unknown-platform static_assert
#     Platform.cpp asserts on unknown platforms; Emscripten is not in the list.
#     Guard the assertion so WASM builds skip it.
# ─────────────────────────────────────────────────────────────────────────────
patch("src/libslic3r/Platform.cpp", [
    (
        r'(static_assert\s*\(\s*false\s*,\s*"Unknown platform detected"\s*\);)',
        r'#ifndef SLIC3R_WASM\n    \1\n#endif',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 6d. GCode/Thumbnails.cpp — define JCS_EXT_RGBA if missing
#     Emscripten ships standard libjpeg (no turbo extensions).
# ─────────────────────────────────────────────────────────────────────────────
patch("src/libslic3r/GCode/Thumbnails.cpp", [
    (
        r'(#include\s*<jpeglib\.h>)',
        r'\1\n#ifndef JCS_EXT_RGBA\n#  define JCS_EXT_RGBA ((J_COLOR_SPACE)13)\n#endif',
        0,
    ),
])

# ─────────────────────────────────────────────────────────────────────────────
# 7. Root CMakeLists.txt — append OrcaWeb bridge + WASM link target injection.
#    The bridge and wasm subdirs live in orca-wasm/ (outside orca/).
#    Their absolute paths are passed at cmake configure time via:
#       -DORCA_WEB_BRIDGE_DIR=...  -DORCA_WEB_WASM_DIR=...
# ─────────────────────────────────────────────────────────────────────────────
BRIDGE_INJECTION = """\

# ── OrcaWeb WASM bridge (injected by orca-wasm/patches/apply.py) ─────────────
if(SLIC3R_WASM AND DEFINED ORCA_WEB_BRIDGE_DIR)
  # Expose OrcaSlicer src/ as ORCA_SRC for the bridge CMakeLists.
  set(ORCA_SRC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  add_subdirectory("${ORCA_WEB_BRIDGE_DIR}" bridge)
  add_subdirectory("${ORCA_WEB_WASM_DIR}"   wasm)
endif()
"""

orca_root_cmake = ORCA / "CMakeLists.txt"
if orca_root_cmake.exists():
    content = orca_root_cmake.read_text(encoding="utf-8")
    if "OrcaWeb WASM bridge" not in content:
        if not DRY_RUN:
            orca_root_cmake.write_text(content + BRIDGE_INJECTION, encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: CMakeLists.txt (bridge injection)")
    else:
        print("  OK (no change): CMakeLists.txt (bridge injection)")

# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        DRY_RUN = True
    print("\nOrcaWeb WASM patcher — done.\n")
