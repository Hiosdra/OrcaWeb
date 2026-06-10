#!/usr/bin/env bash
# Build GMP, MPFR, and CGAL for WebAssembly (Emscripten).
# Sets GMP_WASM_INC, GMP_WASM_LIB, MPFR_WASM_INC, MPFR_WASM_LIB,
# and CGAL_WASM_DIR after a successful build.

set -euo pipefail

MATH_INSTALL="${ORCA_WASM_DIR}/deps/math-wasm-install"
MATH_STAMP="${MATH_INSTALL}/.built"

if [[ -f "${MATH_STAMP}" ]]; then
  echo "  [math] already built — skipping"
  _export_math_vars
  return 0 2>/dev/null || exit 0
fi

_export_math_vars() {
  export GMP_WASM_INC="${MATH_INSTALL}/include"
  export GMP_WASM_LIB="${MATH_INSTALL}/lib/libgmp.a"
  export MPFR_WASM_INC="${MATH_INSTALL}/include"
  export MPFR_WASM_LIB="${MATH_INSTALL}/lib/libmpfr.a"
  export CGAL_WASM_DIR="${MATH_INSTALL}/lib/cmake/CGAL"
}

GMP_VERSION="${GMP_VERSION:-6.3.0}"
MPFR_VERSION="${MPFR_VERSION:-4.2.1}"
CGAL_VERSION="${CGAL_VERSION:-5.6.1}"
DEPS="${ORCA_WASM_DIR}/deps"
mkdir -p "${MATH_INSTALL}"

# ── GMP ──────────────────────────────────────────────────────────────────────
echo "  [gmp] building GMP ${GMP_VERSION}..."
GMP_TAR="${DEPS}/gmp-${GMP_VERSION}.tar.xz"
[[ -f "${GMP_TAR}" ]] || \
  curl -fL "https://gmplib.org/download/gmp/gmp-${GMP_VERSION}.tar.xz" -o "${GMP_TAR}"
tar -xJf "${GMP_TAR}" -C "${DEPS}"
cd "${DEPS}/gmp-${GMP_VERSION}"
emconfigure ./configure \
  --prefix="${MATH_INSTALL}" \
  --disable-shared \
  --enable-static \
  --disable-assembly \
  ABI=32
emmake make -j"$(nproc)"
make install

# ── MPFR ─────────────────────────────────────────────────────────────────────
echo "  [mpfr] building MPFR ${MPFR_VERSION}..."
MPFR_TAR="${DEPS}/mpfr-${MPFR_VERSION}.tar.xz"
[[ -f "${MPFR_TAR}" ]] || \
  curl -fL "https://www.mpfr.org/mpfr-current/mpfr-${MPFR_VERSION}.tar.xz" -o "${MPFR_TAR}"
tar -xJf "${MPFR_TAR}" -C "${DEPS}"
cd "${DEPS}/mpfr-${MPFR_VERSION}"
emconfigure ./configure \
  --prefix="${MATH_INSTALL}" \
  --with-gmp="${MATH_INSTALL}" \
  --disable-shared \
  --enable-static
emmake make -j"$(nproc)"
make install

# ── CGAL (header-only core + cmake config) ───────────────────────────────────
echo "  [cgal] fetching CGAL ${CGAL_VERSION} (header-only)..."
CGAL_TAR="${DEPS}/cgal-${CGAL_VERSION}.tar.xz"
[[ -f "${CGAL_TAR}" ]] || \
  curl -fL \
    "https://github.com/CGAL/cgal/releases/download/v${CGAL_VERSION}/CGAL-${CGAL_VERSION}.tar.xz" \
    -o "${CGAL_TAR}"
tar -xJf "${CGAL_TAR}" -C "${DEPS}"
cd "${DEPS}/CGAL-${CGAL_VERSION}"
emcmake cmake -S . -B build-wasm \
  -G Ninja \
  -DCMAKE_INSTALL_PREFIX="${MATH_INSTALL}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCGAL_DISABLE_GMP=OFF \
  -DGMP_INCLUDE_DIR="${MATH_INSTALL}/include" \
  -DGMP_LIBRARIES="${MATH_INSTALL}/lib/libgmp.a" \
  -DMPFR_INCLUDE_DIR="${MATH_INSTALL}/include" \
  -DMPFR_LIBRARIES="${MATH_INSTALL}/lib/libmpfr.a"
cmake --build build-wasm --target install

touch "${MATH_STAMP}"
_export_math_vars
echo "  [math] done → ${MATH_INSTALL}"
