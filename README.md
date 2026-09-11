# orca-wasm — OrcaSlicer WebAssembly engine

Standalone Emscripten build of [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer)
v2.4.2. This repository contains the C++ bridge, compatibility patches,
toolchain configuration, and release workflow for the host-ready engine.

## Repository layout

```text
orca/                 OrcaSlicer source checkout (submodule or shallow clone)
bridge/               exported C API and host boundary
cmake/                dependency discovery and WASM configuration
overrides/            source overrides for unavailable desktop libraries
patches/              idempotent OrcaSlicer compatibility patcher
wasm/                 Emscripten target and compatibility shims
scripts/              local build, smoke-test, and comparison tools
.github/workflows/    reproducible CI build and release workflow
```

## Artifacts

| File | Description |
|------|-------------|
| `slicer.js` / `slicer.wasm` | Single-threaded compatibility engine |
| `slicer-mt.js` / `slicer-mt.wasm` | Multithreaded engine for COOP/COEP hosts |

The build does not produce `slicer.data`: the headless engine uses its virtual
filesystem only for input and output files.

## Local build

Install Emscripten 3.1.74 and the system tools used by CI (CMake, Ninja,
Python 3, `m4`, `texinfo`, OpenSSL, `ccache`, and a C/C++ toolchain). Then run:

```bash
WASM_VARIANT=st ./scripts/build-local-wsl.sh
WASM_VARIANT=mt ./scripts/build-local-wsl.sh
```

The script builds the pinned OrcaSlicer dependencies, applies `patches/apply.py`,
and writes the selected pair to `artifacts/`. Use `EMSDK=/path/to/emsdk` when
the toolchain is not installed at `/opt/emsdk`.

The generated local script is derived from
`.github/workflows/build-wasm.yml`. After changing that workflow, regenerate it
with:

```bash
node scripts/gen-wsl-build-script.mjs
```

## C API

The module exports the session and conversion functions used by host runtimes:

```text
orc_session_create / orc_session_destroy
orc_init
orc_slice / orc_slice_multi / orc_prepare_plate
orc_obj_to_stl / orc_cad_to_stl
orc_write_3mf / orc_read_3mf
orc_free / orc_decode_exception
```

The JavaScript side calls the Emscripten exports with their `_orc_*` names.
`bridge/slicer.cpp` is the authoritative ABI implementation.

## CI and releases

The `Build WASM` workflow validates pull requests and builds both `st` and
`mt` variants on the default branch. Each successful build runs the real
engine smoke test before publishing immutable GitHub Release assets:

```text
wasm-v2.4.2
wasm-v2.4.2-patchN
wasm-v2.4.2-patchN-multithreaded
```

A rebuild never overwrites an existing release. Consumers should resolve the
highest patch number in the desired release family and use the JavaScript and
WASM files from the same tag. This repository publishes engine releases only;
the frontend deployment is handled separately by the JustSlice-PoC Cloudflare
Workers project.

## Licence and notices

OrcaSlicer and the linked libraries retain their upstream licences. See
[`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md) for source and attribution
details. The bridge and build infrastructure are original project code under the
licence stated in `LICENSE`.
