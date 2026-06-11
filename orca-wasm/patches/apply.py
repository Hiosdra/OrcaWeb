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
        _patched = re.sub(
            r'(#pragma once\n)([\s\S]+)',
            r'\1#ifndef SLIC3R_NO_OCCT\n\2\n#endif // SLIC3R_NO_OCCT\n',
            _content,
            count=1,
            flags=re.MULTILINE | re.DOTALL,
        )
        if not DRY_RUN:
            step_hpp.write_text(_patched, encoding="utf-8")
        print(f"  {'WOULD PATCH' if DRY_RUN else 'PATCHED'}: src/libslic3r/Format/STEP.hpp")
    else:
        print("  OK (no change): src/libslic3r/Format/STEP.hpp")

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
# 4. src/libslic3r/FuzzySkin.cpp — thread_local RNG not allowed in WASM
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

patch("src/libslic3r/FuzzySkin.cpp", [
    (
        r'\bthread_local\s+',
        r'/* thread_local removed for WASM */ ',
        0,
    ),
])

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
