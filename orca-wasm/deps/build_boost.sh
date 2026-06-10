#!/usr/bin/env bash
# Build Boost for WebAssembly (Emscripten).
# Exports BOOST_WASM_ROOT after a successful build.
# Usage:  source deps/build_boost.sh  (or called by build.sh)

set -euo pipefail

BOOST_VERSION="${BOOST_VERSION:-1.83.0}"
BOOST_UNDERSCORE="${BOOST_VERSION//./_}"
BOOST_SRC_DIR="${ORCA_WASM_DIR}/deps/boost_${BOOST_UNDERSCORE}"
BOOST_INSTALL_DIR="${ORCA_WASM_DIR}/deps/boost-wasm-install"
BOOST_STAMP="${BOOST_INSTALL_DIR}/.built_${BOOST_UNDERSCORE}"

if [[ -f "${BOOST_STAMP}" ]]; then
  echo "  [boost] already built — skipping"
  export BOOST_WASM_ROOT="${BOOST_INSTALL_DIR}"
  return 0 2>/dev/null || exit 0
fi

echo "  [boost] downloading Boost ${BOOST_VERSION}..."
mkdir -p "${ORCA_WASM_DIR}/deps"
TARBALL="${ORCA_WASM_DIR}/deps/boost_${BOOST_UNDERSCORE}.tar.gz"
if [[ ! -f "${TARBALL}" ]]; then
  curl -fL \
    "https://boostorg.jfrog.io/artifactory/main/release/${BOOST_VERSION}/source/boost_${BOOST_UNDERSCORE}.tar.gz" \
    -o "${TARBALL}"
fi

echo "  [boost] extracting..."
tar -xzf "${TARBALL}" -C "${ORCA_WASM_DIR}/deps"

echo "  [boost] bootstrapping..."
cd "${BOOST_SRC_DIR}"
./bootstrap.sh --without-libraries=python

# Build header-only + selected compiled libs using Emscripten's em++
cat > user-config.jam <<'JAM'
using clang : emscripten : em++ :
    <compileflags>"-O2 -fno-exceptions"
    <archiveflags>""
    ;
JAM

./b2 install \
  --prefix="${BOOST_INSTALL_DIR}" \
  toolset=clang-emscripten \
  link=static \
  threading=single \
  variant=release \
  --with-filesystem \
  --with-system \
  --with-regex \
  --with-thread \
  --with-atomic \
  --with-chrono \
  --with-date_time \
  --with-iostreams \
  --with-locale \
  --with-log \
  --with-nowide \
  --with-program_options \
  -j"$(nproc)" \
  2>&1 | tail -5

touch "${BOOST_STAMP}"
export BOOST_WASM_ROOT="${BOOST_INSTALL_DIR}"
echo "  [boost] done → ${BOOST_INSTALL_DIR}"
