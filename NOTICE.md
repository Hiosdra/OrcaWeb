# Third-party notices

## OrcaSlicer

orca-wasm embeds a WebAssembly build of **OrcaSlicer** (https://github.com/SoftFever/OrcaSlicer).

- License: GNU Affero General Public License v3.0 (AGPL-3.0)
- Copyright: SoftFever and OrcaSlicer contributors
- Source of the version used: https://github.com/SoftFever/OrcaSlicer/tree/v2.4.0
- Modifications applied for the WASM build: see `orca-wasm/patches/apply.py` in this repository

Per AGPL-3.0 §13, the full source for this modified build (including all patches) is available at:
https://github.com/Hiosdra/orca-wasm

## PrusaSlicer / libslic3r

OrcaSlicer is a fork of **PrusaSlicer** (https://github.com/prusa3d/PrusaSlicer),
which is also licensed under AGPL-3.0.

## host dependency, host dependency, host build tooling and other npm dependencies

See `package.json` for the full dependency list. Each package carries its own license
(MIT unless otherwise stated in the package's own `LICENSE` file).
