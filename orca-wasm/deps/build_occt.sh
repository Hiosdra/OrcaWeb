#!/usr/bin/env bash
# Build a minimal subset of OCCT 7.8.1 for WebAssembly (Emscripten).
#
# Toolkits built: the STEP/IGES import + tessellation subset required by
# OrcaSlicer's Format/STEP.cpp — the same modules shipped in occt-import-js.
#
# Exports OCCT_WASM_DIR after a successful build.
# Usage:  source deps/build_occt.sh  (called by build.sh)

set -euo pipefail

ORCA_WASM_DIR="${ORCA_WASM_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OCCT_VERSION="${OCCT_VERSION:-7.8.1}"
OCCT_TAG="V${OCCT_VERSION//./_}"
OCCT_SRC_DIR="${ORCA_WASM_DIR}/deps/occt-${OCCT_VERSION}"
OCCT_INSTALL_DIR="${ORCA_WASM_DIR}/deps/occt-wasm-install"
OCCT_STAMP="${OCCT_INSTALL_DIR}/.built_${OCCT_TAG}"

_export_occt_vars() {
  export OCCT_WASM_DIR="${OCCT_INSTALL_DIR}"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "OCCT_WASM_DIR=${OCCT_WASM_DIR}" >> "$GITHUB_ENV"
  fi
}

if [[ -f "${OCCT_STAMP}" ]]; then
  echo "  [occt] already built — skipping"
  _export_occt_vars
  return 0 2>/dev/null || exit 0
fi

echo "  [occt] downloading OCCT ${OCCT_VERSION}..."
mkdir -p "${ORCA_WASM_DIR}/deps"
TARBALL="${ORCA_WASM_DIR}/deps/occt-${OCCT_VERSION}.tar.gz"
if [[ ! -f "${TARBALL}" ]]; then
  curl -fL \
    "https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/${OCCT_TAG}.tar.gz" \
    -o "${TARBALL}"
fi

echo "  [occt] extracting..."
if [[ ! -d "${OCCT_SRC_DIR}" ]]; then
  tar -xzf "${TARBALL}" -C "${ORCA_WASM_DIR}/deps"
  mv "${ORCA_WASM_DIR}/deps/OCCT-${OCCT_TAG}" "${OCCT_SRC_DIR}"
fi

# ── Patch OCCT cmake for Emscripten cross-compilation ─────────────────────────
# OCCT 7.8.x has no native Emscripten support. Its Linux cmake branch may
# force BUILD_SHARED_LIBS=ON regardless of command-line flags, and it tries
# to build ExpToCasExe (a host code-generator) via Emscripten — which fails
# because its .so link deps cannot be resolved from the Emscripten sysroot.
# The patches below:
#   1. Guard ExpToCasExe behind CMAKE_CROSSCOMPILING so it is skipped;
#      OCCT ships pre-generated Express schema .cxx files, so the tool is
#      not needed during a standard build.
#   2. Prevent any set(BUILD_SHARED_LIBS ON ... FORCE) from overriding our
#      -DBUILD_SHARED_LIBS=OFF when cross-compiling.
echo "  [occt] applying Emscripten cross-compilation patches..."
python3 - "${OCCT_SRC_DIR}" <<'PYEOF'
import re, pathlib, sys

root = pathlib.Path(sys.argv[1])
changes = 0

def patch_file(p, patterns):
    global changes
    try:
        text = p.read_text(errors='replace')
        orig = text
        for pat, repl in patterns:
            text = re.sub(pat, repl, text, flags=re.MULTILINE | re.DOTALL)
        if text != orig:
            p.write_text(text)
            print(f"  patched: {p.relative_to(root)}")
            changes += 1
    except Exception as e:
        print(f"  skip {p}: {e}", file=sys.stderr)

all_cmake = list(root.rglob('CMakeLists.txt')) + list(root.rglob('*.cmake'))

for f in all_cmake:
    patch_file(f, [
        (
            r'(?<!endif \()\b(add_subdirectory\s*\(\s*(?:"[^"]*"|\'[^\']*\'|[^)]*?)[Ee]xp[Tt]o[Cc]as[Ee]xe[^)]*\))',
            r'if (NOT CMAKE_CROSSCOMPILING)\n  \1\nendif ()',
        ),
        (
            r'(set\s*\(\s*BUILD_SHARED_LIBS\s+ON\b[^)]*FORCE[^)]*\))',
            r'if (NOT CMAKE_CROSSCOMPILING)\n  \1\nendif ()',
        ),
    ])

print(f"[occt-patch] {changes} file(s) modified")
PYEOF
cmake \
  -S "${OCCT_SRC_DIR}" \
  -B "${OCCT_SRC_DIR}/build-wasm" \
  -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${OCCT_INSTALL_DIR}" \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_CROSSCOMPILING_EMULATOR="node" \
  \
  -DBUILD_MODULE_Draw=OFF \
  -DBUILD_MODULE_Visualization=OFF \
  -DBUILD_MODULE_FoundationClasses=ON \
  -DBUILD_MODULE_ModelingData=ON \
  -DBUILD_MODULE_ModelingAlgorithms=ON \
  -DBUILD_MODULE_DataExchange=ON \
  -DBUILD_MODULE_ApplicationFramework=ON \
  \
  -DUSE_FREETYPE=OFF \
  -DUSE_OPENGL2=OFF \
  -DUSE_TCL=OFF \
  -DUSE_TK=OFF \
  -DUSE_FFMPEG=OFF \
  -DUSE_FREEIMAGE=OFF \
  -DUSE_RAPIDJSON=OFF \
  -DUSE_DRACO=OFF \
  -DUSE_VTK=OFF \
  -DUSE_TBB=OFF \
  \
  -DCMAKE_CXX_FLAGS="-O2 -fexceptions -Wno-deprecated-anon-enum-enum-conversion -Wno-unknown-warning-option" \
  -DCMAKE_C_FLAGS="-O2"

# ── Build ─────────────────────────────────────────────────────────────────────
echo "  [occt] building (first run ~30–60 min)..."
cmake --build "${OCCT_SRC_DIR}/build-wasm" -j"$(nproc 2>/dev/null || echo 4)"

# ── Install ───────────────────────────────────────────────────────────────────
echo "  [occt] installing to ${OCCT_INSTALL_DIR}..."
# cmake --install (not emmake) — install is just file copying
cmake --install "${OCCT_SRC_DIR}/build-wasm"

touch "${OCCT_STAMP}"
_export_occt_vars
echo "  [occt] done → ${OCCT_INSTALL_DIR}"
