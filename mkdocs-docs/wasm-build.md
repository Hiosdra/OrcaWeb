# Building the WASM Engine

This page explains how to compile OrcaSlicer v2.4.0 to WebAssembly using the `orca-wasm/` build pipeline. You only need this if you want to change the C++ engine itself. For normal development of the web UI or CLI, download the pre-built artifacts with `node scripts/download-wasm.mjs`.

## When to build

| Scenario | Action |
|----------|--------|
| Develop the React UI or CLI | `node scripts/download-wasm.mjs` — done |
| Change C++ bridge (`orca-wasm/bridge/slicer.cpp`) | Rebuild WASM |
| Update to a newer OrcaSlicer version | Rebuild WASM |
| Add or change an override stub or shim | Rebuild WASM |

## Artifacts

The build produces two files (published to GitHub Release `wasm-v2.4.0`):

| File | Size | Description |
|------|------|-------------|
| `slicer.wasm` | ~29 MB | Compiled OrcaSlicer v2.4.0 core + OCCT (STEP engine) |
| `slicer.js` | ~210 KB | Emscripten glue code (CommonJS IIFE) |

There is no `slicer.data` — the headless flat-config slicer never reads `orca/resources` at runtime, so the 200 MB preload file was eliminated entirely.

## Build pipeline

```
emsdk (Emscripten toolchain)
  │
  ├─ Build dependencies once, cache in orca-wasm/deps-install/
  │   ├── Boost 1.83  (b2, toolset=emscripten, BOOST_LOG_NO_THREADS=1)
  │   ├── GMP / MPFR / CGAL
  │   ├── Eigen / nlohmann / EXPAT / NLopt / cereal
  │   └── Emscripten ports: zlib, libpng, libjpeg
  │
  ├─ Checkout OrcaSlicer v2.4.0 (git submodule orca/orca/)
  │
  ├─ python3 orca-wasm/patches/apply.py   ← idempotent; patches the checkout
  │
  └─ cmake -S orca-wasm -B build -DSLIC3R_WASM=ON
     ninja slicer
       → build/slicer.js
       → build/slicer.wasm
```

Dependencies are cached between runs (GitHub Actions cache key based on dependency versions). A cold build (deps + compile) takes ~2.5–3 h, of which OCCT alone is ~45–60 min. With warm dep and `ccache` caches, a build that only touches C++ source takes ~10–15 min.

## Triggering a build

=== "GitHub Actions (recommended)"

    Two ways to trigger:

    - **Manual dispatch:** go to **Actions → Build WASM → Run workflow**, enter the OrcaSlicer tag (e.g. `v2.4.0`), and run.
    - **Tag push:** push a tag matching `wasm-v*.*.*` (e.g. `git tag wasm-v2.4.0-ow2 && git push --tags`). The workflow picks up the tag automatically.

    Both paths:

    1. Build and cache dependencies
    2. Check out the OrcaSlicer submodule at the specified tag
    3. Apply `patches/apply.py`
    4. Compile with `cmake + ninja`
    5. Publish artifacts to the corresponding GitHub Release

    Builds on pull requests that touch `orca-wasm/**` run automatically but skip the release-publish step.

=== "Local (Linux / macOS / WSL2)"

    Windows users: WSL2 works well for this (Windows-native emsdk + this dep
    chain is a much rockier path — Boost's `b2`, GMP/MPFR's `configure`, and
    OCCT's CMake all assume a POSIX toolchain).

    ```bash
    # Install build tools (Arch example — use your distro's equivalents)
    pacman -S --needed git cmake ninja python m4 texinfo openssl ccache base-devel

    # Install emsdk (pinned to match CI — see EMSDK_VERSION in build-wasm.yml)
    git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk
    /opt/emsdk/emsdk install 3.1.74 && /opt/emsdk/emsdk activate 3.1.74

    # Clone the repo and build — run from the repo root, not orca-wasm/
    git clone https://github.com/Hiosdra/OrcaWeb.git && cd OrcaWeb
    ./orca-wasm/scripts/build-local-wsl.sh
    ```

    This script is generated from `.github/workflows/build-wasm.yml` itself
    (via `node scripts/gen-wsl-build-script.mjs`), so it stays accurate as the
    CI pipeline changes — re-run the generator after editing the workflow
    rather than hand-editing the script. First run builds all dependencies
    from scratch (~90–100 min, mostly OCCT); subsequent runs skip
    already-built deps via stamp files in `orca-wasm/deps-install/`, and
    `ccache` (set up automatically, `~/.cache/ccache`) makes repeat C++
    compiles of unchanged files fast.

    Artifacts land directly in `public/wasm/slicer.js` / `slicer.wasm`
    (also copied to `wasm-artifacts/` to mirror the CI upload step) — no
    manual copy needed.

    `orca-wasm/scripts/build.sh` still exists but targets OrcaSlicer v2.3.2
    and predates the current bridge integration — it's kept for reference
    only, don't use it for v2.4.0 builds.

## Applying patches before build

`patches/apply.py` patches the OrcaSlicer source tree to make it compile under Emscripten. It is safe to run multiple times (idempotent):

```bash
python3 orca-wasm/patches/apply.py        # apply all patches
python3 orca-wasm/patches/apply.py --check  # dry-run — print what would change
```

See [Architecture → Engine clean layer](architecture.md#engine-clean-layer-override-approach) for the full list of what each patch does.

## Two non-obvious gotchas

### Boost.Log namespace mismatch (`v2s_st` vs `v2s_mt_posix`)

**Symptom:** hundreds of `undefined symbol: boost::log::v2s_mt_posix::*` from `wasm-ld`.

**Cause:** Boost must be built with `BOOST_LOG_NO_THREADS=1`, which puts log symbols in the `v2s_st` namespace. If the libslic3r consumer doesn't define the same flag it expects `v2s_mt_posix` — ABI mismatch.

**Fix:** `BOOST_LOG_NO_THREADS=1` is set for **both** the Boost build (`b2 define=BOOST_LOG_NO_THREADS`) and the libslic3r build (via `add_compile_definitions()` in `orca-wasm/cmake/wasm_find_paths.cmake`). The `utils.cpp` patch replaces `synchronous_sink` → `unlocked_sink` and removes the `[Thread …]` log field, which don't exist in the single-thread Boost build.

### `-sEMULATE_FUNCTION_POINTER_CASTS=1` crashes `wasm-opt`

**Symptom:** SIGABRT in `mixed_arena.h:188` (Binaryen) during the `--fpcast-emu` optimisation pass at `-O3`. The `wasm-ld` link step succeeds; only the optimiser crashes.

**Fix:** the flag is not used. Removed from `orca-wasm/wasm/CMakeLists.txt`. The module instantiates and slices correctly without the function-pointer-cast emulator — no runtime traps have been observed.

## Updating the OrcaSlicer version

1. Update `ORCA_VERSION` in `.github/workflows/build-wasm.yml`
2. Update the submodule: `git -C orca-wasm/orca checkout v<new-version>`
3. Re-run `patches/apply.py --check` and fix any patch failures
4. Trigger the `Build WASM` workflow
5. Update the release tag in `deploy.yml` and `scripts/download-wasm.mjs`
