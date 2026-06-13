#!/usr/bin/env python3
"""
Apply WASM compatibility changes to the OrcaSlicer source tree.

Strategy
--------
* CMakeLists.txt files are patched in-place (unavoidable — OrcaSlicer has no
  upstream WASM build support).
* C++ *stub* files (OCCT, OpenVDB, OpenCV, Draco, libnoise) are NOT modified.
  Instead, the CMake injection in section 4c marks the originals as
  HEADER_FILE_ONLY and adds our standalone override files from
  ``orca-wasm/overrides/``.  This keeps ``orca/`` free of C++ changes.
* C++ *bugfixes* (narrowing, Eigen deduction, Boost.Log, Platform assert,
  thumbnail jpg→png) are still patched in-place; these are genuine
  compatibility issues that should be upstreamed to OrcaSlicer.

Run from orca-wasm/ with:

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


# =============================================================================
# 1. Root CMakeLists.txt — add SLIC3R_WASM option; make heavy deps conditional
# =============================================================================
patch("CMakeLists.txt", [
    # Add SLIC3R_WASM option near the top (after project() line)
    (
        r'(project\s*\(\s*OrcaSlicer[^)]*\))',
        r'\1\n\noption(SLIC3R_WASM "Build for WebAssembly with Emscripten" OFF)',
        1,
    ),
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
    # Downgrade CMP0167 so the legacy FindBoost.cmake (module mode) is used.
    # Our Boost is built with b2 which does not install BoostConfig.cmake.
    (
        r'cmake_policy\s*\(\s*SET\s+CMP0167\s+NEW\s*\)',
        r'cmake_policy(SET CMP0167 OLD)',
        0,
    ),
])

# =============================================================================
# 2. src/CMakeLists.txt — skip GUI subdirectory in WASM builds
# =============================================================================
patch("src/CMakeLists.txt", [
    (
        r'(add_subdirectory\s*\(\s*(?:GUI|slic3r|OrcaSlicer|bambu_studio)\s*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
    (
        r'(find_package\s*\(\s*libnoise\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
])

# =============================================================================
# 3. GCode.hpp — fix narrowing in LayerResult::make_nop_layer_result
#    On 32-bit WASM, size_t is uint32_t; std::numeric_limits<coord_t>::max()
#    = INT64_MAX cannot narrow to size_t → [-Wc++11-narrowing] compile error.
# =============================================================================
patch("src/libslic3r/GCode.hpp", [
    (
        r'(\{"",\s*)std::numeric_limits<coord_t>::max\(\)',
        r'\1static_cast<size_t>(-1)',
        0,
    ),
])

# =============================================================================
# 3b. Model.cpp — guard read_from_step() definition
#     Our override STEP.cpp defines Model::read_from_step; guard the original
#     to prevent a duplicate-symbol link error.
# =============================================================================
_model_cpp = ORCA / "src/libslic3r/Model.cpp"
if _model_cpp.exists():
    _mc = _model_cpp.read_text(encoding="utf-8", errors="replace")
    if "#ifndef SLIC3R_NO_OCCT" not in _mc:
        _m = re.search(r'\nModel Model::read_from_step\s*\(', _mc)
        if _m:
            _func_start = _m.start() + 1
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

# =============================================================================
# 4. src/libslic3r/CMakeLists.txt — make OCCT / OpenCV / draco conditional
# =============================================================================
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
    # Wrap JPEG find / link
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
    # Freetype is linked for non-WIN32; Emscripten is non-WIN32, so guard it
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
    # noise::noise
    (
        r'\bnoise::noise\b',
        r'$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:noise::noise>',
        0,
    ),
    # encoding_check() runs a native binary — would fail on WASM runner
    (
        r'(encoding_check\s*\([^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,
    ),
])

# =============================================================================
# 4a. AABBTreeLines.hpp — Eigen template deduction fix
#     origin.cast<Scalar>() returns a lazy CwiseUnaryOp that does not match
#     Eigen::Matrix in deduction; explicitly construct with decltype(nearest_point).
# =============================================================================
patch("src/libslic3r/AABBTreeLines.hpp", [
    (
        r'(distance_to_squared\(line,\s*)(origin\.template cast<typename LineType::Scalar>\(\))(?:\.eval\(\))?',
        r'\1decltype(nearest_point)(\2)',
        0,
    ),
])

# =============================================================================
# 4c. src/libslic3r/CMakeLists.txt — inject WASM override sources
#     Appended (not inline-patched) so it survives minor upstream reshuffles.
#     Marks original stub-only files as HEADER_FILE_ONLY (not compiled) and
#     adds the clean override files from orca-wasm/overrides/.
#     Also injects the overrides include path at higher priority than orca/src/
#     so that #include "Format/STEP.hpp" etc. find our stubs first.
# =============================================================================
LIBSLIC3R_OVERRIDES_INJECTION = """\

# ── OrcaWeb WASM overrides (injected by orca-wasm/patches/apply.py) ──────────
# Original C++ stub files are excluded from compilation; clean override
# implementations from orca-wasm/overrides/ are added instead.
# This keeps the orca/ source tree free of C++ modifications.
if(SLIC3R_WASM AND DEFINED ORCA_WEB_OVERRIDES_DIR)
  # Files always present in OrcaSlicer
  set(_wasm_orig_stubs
    "${CMAKE_CURRENT_SOURCE_DIR}/Format/STEP.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/Format/DRC.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/Format/svg.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/OpenVDBUtils.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/ObjColorUtils.cpp"
  )
  # Files that may be reorganised in future OrcaSlicer versions
  set(_wasm_maybe_stubs
    "${CMAKE_CURRENT_SOURCE_DIR}/SLA/Hollowing.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/Shape/TextShape.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/Feature/FuzzySkin/FuzzySkin.cpp"
  )
  foreach(_f IN LISTS _wasm_maybe_stubs)
    if(EXISTS "${_f}")
      list(APPEND _wasm_orig_stubs "${_f}")
    endif()
  endforeach()
  set_source_files_properties(${_wasm_orig_stubs} PROPERTIES HEADER_FILE_ONLY TRUE)

  target_sources(libslic3r PRIVATE
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/Format/STEP.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/Format/DRC.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/Format/svg.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/OpenVDBUtils.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/ObjColorUtils.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/SLA/Hollowing.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/Shape/TextShape.cpp"
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r/Feature/FuzzySkin/FuzzySkin.cpp"
  )

  # Override headers take priority: #include "Format/STEP.hpp" etc. find our
  # stubs before the OCCT/OpenVDB/OpenCV-dependent originals.
  target_include_directories(libslic3r BEFORE PUBLIC
    "${ORCA_WEB_OVERRIDES_DIR}/src/libslic3r"
  )
endif()
"""

_libslic3r_cmake = ORCA / "src/libslic3r/CMakeLists.txt"
if _libslic3r_cmake.exists():
    _lc = _libslic3r_cmake.read_text(encoding="utf-8")
    if "OrcaWeb WASM overrides" not in _lc:
        if not DRY_RUN:
            _libslic3r_cmake.write_text(_lc + LIBSLIC3R_OVERRIDES_INJECTION, encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/CMakeLists.txt (overrides injection)")
    else:
        print("  OK (no change): src/libslic3r/CMakeLists.txt (overrides injection)")

# =============================================================================
# 5. Platform.cpp — suppress unknown-platform static_assert
#    Emscripten is not in OrcaSlicer's known-platform list.
# =============================================================================
patch("src/libslic3r/Platform.cpp", [
    (
        r'(static_assert\s*\(\s*false\s*,\s*"Unknown platform detected"\s*\);)',
        r'#ifndef SLIC3R_WASM\n    \1\n#endif',
        0,
    ),
])

# =============================================================================
# 6. GCode/Thumbnails.cpp — JPEG compatibility for Emscripten
#    6a: define JCS_EXT_RGBA if libjpeg-turbo extension is missing
#    6b: replace compress_thumbnail_jpg body with a PNG fallback
#        (libjpeg is not linked in WASM; JPEG::JPEG is guarded in CMakeLists)
# =============================================================================
patch("src/libslic3r/GCode/Thumbnails.cpp", [
    (
        r'(#include\s*<jpeglib\.h>)',
        r'\1\n#ifndef JCS_EXT_RGBA\n#  define JCS_EXT_RGBA ((J_COLOR_SPACE)13)\n#endif',
        0,
    ),
])

_thumb_cpp = ORCA / "src/libslic3r/GCode/Thumbnails.cpp"
if _thumb_cpp.exists():
    _tc = _thumb_cpp.read_text(encoding="utf-8", errors="replace")
    if "// WASM: JPG thumbnails fall back to PNG" not in _tc:
        _m = re.search(
            r'std::unique_ptr<CompressedImageBuffer>\s+compress_thumbnail_jpg\s*\([^)]*\)\s*',
            _tc,
        )
        if _m:
            _brace_start = _tc.index('{', _m.end())
            _depth = 0
            _body_end = _brace_start
            for _i in range(_brace_start, len(_tc)):
                if _tc[_i] == '{':
                    _depth += 1
                elif _tc[_i] == '}':
                    _depth -= 1
                    if _depth == 0:
                        _body_end = _i + 1
                        break
            _new_body = (
                "{\n"
                "    // WASM: JPG thumbnails fall back to PNG (libjpeg not linked).\n"
                "    return compress_thumbnail_png(data);\n"
                "}"
            )
            _tc_new = _tc[:_brace_start] + _new_body + _tc[_body_end:]
            if not DRY_RUN:
                _thumb_cpp.write_text(_tc_new, encoding="utf-8")
            print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/GCode/Thumbnails.cpp (jpg->png fallback)")
        else:
            print("  WARN: compress_thumbnail_jpg not found in Thumbnails.cpp")
    else:
        print("  OK (no change): src/libslic3r/GCode/Thumbnails.cpp (jpg fallback)")

# =============================================================================
# 7. utils.cpp — single-threaded Boost.Log compatibility
#    Boost is built with BOOST_LOG_NO_THREADS so the MT sink type and
#    current_thread_id attribute don't exist.
# =============================================================================
patch("src/libslic3r/utils.cpp", [
    (
        r'boost::log::sinks::synchronous_sink<boost::log::sinks::text_file_backend>',
        r'boost::log::sinks::unlocked_sink<boost::log::sinks::text_file_backend>',
        0,
    ),
    (
        r'<<\s*"\[Thread\s*"\s*<<\s*expr::attr<attrs::current_thread_id::value_type>\("ThreadID"\)\s*<<\s*"\]"',
        r'',
        0,
    ),
])

# =============================================================================
# 8. Root CMakeLists.txt — append OrcaWeb bridge + WASM link target
# =============================================================================
BRIDGE_INJECTION = """\

# ── OrcaWeb WASM bridge (injected by orca-wasm/patches/apply.py) ─────────────
if(SLIC3R_WASM AND DEFINED ORCA_WEB_BRIDGE_DIR)
  # Expose OrcaSlicer src/ as ORCA_SRC for the bridge CMakeLists.
  set(ORCA_SRC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  add_subdirectory("${ORCA_WEB_BRIDGE_DIR}" bridge)
  add_subdirectory("${ORCA_WEB_WASM_DIR}"   wasm)
endif()
"""

_orca_root_cmake = ORCA / "CMakeLists.txt"
if _orca_root_cmake.exists():
    _content = _orca_root_cmake.read_text(encoding="utf-8")
    if "OrcaWeb WASM bridge" not in _content:
        if not DRY_RUN:
            _orca_root_cmake.write_text(_content + BRIDGE_INJECTION, encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: CMakeLists.txt (bridge injection)")
    else:
        print("  OK (no change): CMakeLists.txt (bridge injection)")

# =============================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        DRY_RUN = True
    print("\nOrcaWeb WASM patcher — done.\n")
