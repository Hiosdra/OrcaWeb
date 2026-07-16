# Third-party notices

## OrcaSlicer

OrcaWeb embeds a WebAssembly build of **OrcaSlicer** (https://github.com/SoftFever/OrcaSlicer).

- License: GNU Affero General Public License v3.0 (AGPL-3.0)
- Copyright: SoftFever and OrcaSlicer contributors
- Source of the version used: https://github.com/SoftFever/OrcaSlicer/tree/v2.4.2
- Modifications applied for the WASM build: see `orca-wasm/patches/apply.py` in this repository

Per AGPL-3.0 §13, the full source for this modified build (including all patches) is available at:
https://github.com/Hiosdra/OrcaWeb

## PrusaSlicer / libslic3r

OrcaSlicer is a fork of **PrusaSlicer** (https://github.com/prusa3d/PrusaSlicer),
which is also licensed under AGPL-3.0.

## OCCT (Open CASCADE Technology)

OCCT 7.8.1 (https://github.com/Open-Cascade-SAS/OCCT) is compiled directly into
`slicer.wasm`/`slicer-mt.wasm` to provide STEP import (see
[architecture.md](mkdocs-docs/architecture.md#c-override-stubs-orca-wasmoverrides)).

- License: Open CASCADE Technology Public License (a modified LGPL-2.1 with a
  static-linking exception)
- Copyright: Open Cascade SAS and OCCT contributors

## oneTBB

The multithreaded (MT) engine variant (`slicer-mt.wasm`) links
**oneTBB** v2021.13.2 (https://github.com/uxlfoundation/oneTBB), built from
source for `wasm32-emscripten` — see [ADR-011](mkdocs-docs/adr/adr-011-multithreaded-engine.md).
The single-threaded (ST) variant uses sequential header-only stubs instead
(no oneTBB code compiled in — see [ADR-007](mkdocs-docs/adr/adr-007-tbb-stubs.md)).

- License: Apache License 2.0
- Copyright: Intel Corporation and oneTBB contributors

## libnoise

libnoise (Perlin/Billow/RidgedMulti/Voronoi noise, used for the FuzzySkin
feature) is compiled into the WASM engine and linked normally — see
[architecture.md](mkdocs-docs/architecture.md#libnoise).

- License: GNU Lesser General Public License v2.1 (LGPL-2.1)
- Copyright: Jason Bevins and libnoise contributors

## React, Three.js, Vite and other npm dependencies

See `package.json` for the full dependency list. Each package carries its own license
(MIT unless otherwise stated in the package's own `LICENSE` file).

## Voron Design Cube v7 (E2E test fixture)

`e2e/fixtures/voron-design-cube-v7.stl` is a real-world calibration print used as the
fixture for the E2E slicing smoke test (see ADR-010).

- Source: https://github.com/VoronDesign/Voron-2/blob/3b4c0e4a4e88086b04474fec28a54ab82917fc8a/STLs/Test_Prints/Voron_Design_Cube_v7.stl
- License: GNU General Public License v3.0 (GPL-3.0), per the Voron-2 repository's `LICENSE`
- Copyright: Voron Design and Voron-2 contributors
- Unmodified from the source above

GPL-3.0 and this repository's AGPL-3.0-or-later are explicitly designed by the FSF to be
combinable (GPLv3 §13 / AGPLv3 §13), so vendoring this file alongside AGPL-3.0-licensed
OrcaSlicer code does not create a license conflict.
