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
    # Wrap find_package(TBB ...) so our FindTBB.cmake shim is used when WASM
    (
        r'(find_package\s*\(\s*TBB\b[^)]*\))',
        r'if(NOT SLIC3R_WASM)\n\1\nendif()',
        0,  # optional — already wrapped by a prior run
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
    # CMP0167 NEW removes the legacy FindBoost.cmake module (requires BoostConfig.cmake).
    # Our Boost is built with b2 which does NOT install BoostConfig.cmake, so we
    # revert to CMP0167 OLD to keep the legacy FindBoost.cmake in play.
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
    # Wrap draco link
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
])

# Note: GCode.cpp uses tbb::parallel_pipeline for layer generation — this IS
# the critical G-code export path.  Our tbb/parallel_pipeline.h shim implements
# a correct sequential version, so no source-level guarding is needed here.

# ─────────────────────────────────────────────────────────────────────────────
# 4. src/libslic3r/FuzzySkin.cpp — thread_local RNG not allowed in WASM
# ─────────────────────────────────────────────────────────────────────────────
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
