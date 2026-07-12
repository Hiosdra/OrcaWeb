#!/usr/bin/env bash
# Packages the two built variants (public/dist-st/, public/dist-mt/) into
# release-ready bundles, each a self-contained copy of everything needed to
# run the demo (HTML/JS + that variant's compiled WASM + a copy of server.js).
#
# Usage: ./package.sh <version>   (e.g. ./package.sh v0.1.0)
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:?usage: package.sh <version>, e.g. package.sh v0.1.0}"

if [[ ! -f public/dist-st/parallel_demo.wasm || ! -f public/dist-mt/parallel_demo.wasm ]]; then
  echo "error: run ./build.sh first (missing public/dist-st/ or public/dist-mt/ output)" >&2
  exit 1
fi

OUT="release-artifacts"
rm -rf "$OUT"
mkdir -p "$OUT/single-threaded" "$OUT/multithreaded"

package_variant() {
  local variant_dist="$1" out_subdir="$2" label="$3"
  local stage
  stage="$(mktemp -d)"

  # server.js serves from ./public/ (path.join(__dirname, 'public')) — mirror
  # that layout exactly so the packaged bundle runs with `node server.js`
  # unmodified.
  cp server.js package.json "$stage/"
  mkdir -p "$stage/public/${variant_dist}"
  cp public/index.html public/app.js public/worker.js "$stage/public/"
  # Ship only the requested variant's compiled output — worker.js still
  # feature-detects at runtime, but this keeps each release asset minimal
  # and unambiguous about which engine it was built to demonstrate.
  cp "public/${variant_dist}"/parallel_demo.js "public/${variant_dist}"/parallel_demo.wasm \
    "$stage/public/${variant_dist}/"

  local archive="${OUT}/${out_subdir}/wasm-threads-poc-${VERSION}-${out_subdir}.tar.gz"
  tar -czf "$archive" -C "$stage" .
  rm -rf "$stage"
  echo "  packaged ${label} -> ${archive}"
}

echo "==> Packaging release-artifacts/ for version ${VERSION}"
package_variant "dist-st" "single-threaded" "single-threaded (no -pthread)"
package_variant "dist-mt" "multithreaded" "multithreaded (-pthread)"

echo "Done:"
find "$OUT" -type f
