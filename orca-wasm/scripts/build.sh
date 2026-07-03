#!/usr/bin/env bash
# OUTDATED — targets OrcaSlicer v2.3.2 and a dep/CMake layout that predates
# the current bridge integration (ORCA_WEB_BRIDGE_DIR etc.) and the
# Eigen/nlohmann/EXPAT/NLopt/cereal/libnoise dep steps. Use
# orca-wasm/scripts/build-local-wsl.sh instead (generated from and kept in
# sync with .github/workflows/build-wasm.yml via scripts/gen-wsl-build-script.mjs).
# Kept here for reference only — not deleted since nothing here asked for that.
#
# Build OrcaSlicer v2.3.2 WASM module and copy artifacts to public/wasm/.
#
# Prerequisites (installed or on PATH):
#   - Emscripten (emsdk, emcmake, emmake)
#   - CMake 3.22+, Ninja, Python 3, curl
#
# Usage:
#   cd orca-wasm
#   ./scripts/build.sh [--clean] [--jobs N]

set -euo pipefail
cd "$(dirname "$0")/.."
export ORCA_WASM_DIR="$(pwd)"

# ── Parse arguments ───────────────────────────────────────────────────────────
CLEAN=0
JOBS="$(nproc 2>/dev/null || echo 4)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --jobs)  JOBS="$2"; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
  shift
done

# ── Activate Emscripten ───────────────────────────────────────────────────────
if [[ -z "${EMSDK:-}" ]]; then
  echo "ERROR: EMSDK environment variable not set."
  echo "       Source emsdk_env.sh first:  source /opt/emsdk/emsdk_env.sh"
  exit 1
fi
# shellcheck source=/dev/null
source "${EMSDK}/emsdk_env.sh"

# ── Ensure OrcaSlicer submodule is present ────────────────────────────────────
if [[ ! -f "orca/src/libslic3r/CMakeLists.txt" ]]; then
  echo "[setup] initialising OrcaSlicer submodule..."
  git -C .. submodule update --init --depth 1 -- orca-wasm/orca
  # Check out the target tag
  git -C orca fetch --tags --depth 1 origin v2.3.2
  git -C orca checkout v2.3.2
fi

# ── Build dependencies ────────────────────────────────────────────────────────
echo "[deps] building Boost for WASM..."
# shellcheck source=deps/build_boost.sh
source deps/build_boost.sh

echo "[deps] building GMP / MPFR / CGAL for WASM..."
# shellcheck source=deps/build_math.sh
source deps/build_math.sh

echo "[deps] building OCCT for WASM..."
# shellcheck source=deps/build_occt.sh
source deps/build_occt.sh

# ── Apply source patches ──────────────────────────────────────────────────────
echo "[patch] applying WASM compatibility patches..."
python3 patches/apply.py

# ── Configure ─────────────────────────────────────────────────────────────────
BUILD_DIR="build-wasm"
if [[ $CLEAN -eq 1 ]] && [[ -d "${BUILD_DIR}" ]]; then
  echo "[cmake] cleaning build directory..."
  rm -rf "${BUILD_DIR}"
fi
mkdir -p "${BUILD_DIR}"

echo "[cmake] configuring with Emscripten..."
emcmake cmake \
  -S . \
  -B "${BUILD_DIR}" \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DSLIC3R_WASM=ON \
  -DBOOST_ROOT="${BOOST_WASM_ROOT}" \
  -DBOOST_INC="${BOOST_WASM_ROOT}/include" \
  -DGMP_INCLUDE_DIR="${GMP_WASM_INC}" \
  -DGMP_LIBRARIES="${GMP_WASM_LIB}" \
  -DMPFR_INCLUDE_DIR="${MPFR_WASM_INC}" \
  -DMPFR_LIBRARIES="${MPFR_WASM_LIB}" \
  -DCGAL_DIR="${CGAL_WASM_DIR}" \
  -DOCCT_WASM_DIR="${OCCT_WASM_DIR}" \
  -DORCA_SRC="${ORCA_WASM_DIR}/orca/src" \
  -DORCA_DEPS="${ORCA_WASM_DIR}/orca/deps_src"

# ── Build ─────────────────────────────────────────────────────────────────────
echo "[build] compiling OrcaSlicer WASM module (this takes ~20–40 min first run)..."
emmake cmake --build "${BUILD_DIR}" --target slicer -j "${JOBS}"

echo ""
echo "✓ Build complete. Artifacts copied to public/wasm/:"
ls -lh "../public/wasm/slicer."* 2>/dev/null || true
