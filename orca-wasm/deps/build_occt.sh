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

# ── Configure ─────────────────────────────────────────────────────────────────
# OCCT ignores the standard BUILD_SHARED_LIBS flag — it selects the library type
# from its own BUILD_LIBRARY_TYPE cache variable, which defaults to "Shared" and
# then force-sets BUILD_SHARED_LIBS=ON (CMakeLists.txt:55, no platform guard).
# Emscripten cannot resolve transitive .so dependencies from outside its sysroot,
# so the link of OCCT's ExpToCasExe host tool fails with
# "libTKExpress.so: dependency not found: libTKernel.so".  BUILD_LIBRARY_TYPE=Static
# makes OCCT emit .a archives and is the only flag that actually controls this.
# The toolchain file is used directly (not emcmake) for explicit
# CMAKE_SYSTEM_NAME=Emscripten, and CMAKE_CROSSCOMPILING_EMULATOR=node lets cmake
# run any in-build codegen tools via Node.
echo "  [occt] configuring with Emscripten..."
cmake \
  -S "${OCCT_SRC_DIR}" \
  -B "${OCCT_SRC_DIR}/build-wasm" \
  -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${OCCT_INSTALL_DIR}" \
  -DBUILD_LIBRARY_TYPE=Static \
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
