# Benchmark: Single-Threaded vs Multithreaded Engine

OrcaWeb ships two builds of the same OrcaSlicer engine: the **single-threaded
(ST)** engine served everywhere, and a **multithreaded (MT)** engine — real
oneTBB linked against Emscripten pthreads — served only where the page is
cross-origin isolated (the Cloudflare mirror; see
[ADR-011](adr/adr-011-multithreaded-engine.md), which also records the
underlying design constraints).

This page records how the two compare on slice wall-clock time. The short
version: **MT is not a universal speedup. It loses on trivial geometry and
wins — up to ~2× — on the complex, real-world models that are actually slow to
slice.**

## Method

- Both engines driven headlessly through the real bridge API (`orc_init` +
  `orc_slice`) in Node 22 — the same code path the browser worker uses — on a
  **16-logical-core** Windows machine.
- Default preset: Bambu Lab P1S / PLA / 0.2 mm layers / **Arachne** walls /
  2 walls / 15 % crosshatch infill.
- Timing is the `orc_slice` call only (engine load excluded). Median of 2 warm
  runs for fast models; a single run for the multi-hundred-second models.
- MT ran with its shipped configuration: no thread cap, pthread pool sized to
  `navigator.hardwareConcurrency` — so oneTBB uses ~16 threads on this machine.

!!! note "Measured in Node, not a browser"
    These are engine-compute numbers. In a real browser the MT engine also
    pays a one-time cost to spawn its worker pool at load, and the ST/MT
    *ratio* per slice is what transfers — not the absolute millisecond counts.

## Synthetic cubes (simple geometry)

Solid cubes at increasing size — lots of layers, but trivial per-layer work.

| Model      | Layers | ST      | MT      | Speedup (ST/MT) |
|------------|-------:|--------:|--------:|----------------:|
| Cube 10 mm |     52 |  321 ms |  527 ms | 0.61× |
| Cube 20 mm |    102 |  230 ms |  323 ms | 0.71× |
| Cube 40 mm |    202 |  601 ms |  769 ms | 0.78× |
| Cube 60 mm |    302 | 1563 ms | 1737 ms | 0.90× |
| Cube 80 mm |    402 | 3011 ms | 2822 ms | 1.07× |

MT is **slower** on cubes and only reaches break-even by 80 mm. A cube's
per-layer work (a few straight perimeters + sparse infill) is too light to
parallelize; the run is dominated by inherently serial phases (notably G-code
serialization) that oneTBB never touches, so thread-coordination overhead just
cancels the small gain.

## Real-world models (complex geometry)

Real prints — the case MT exists for.

| Model                     | Size   | Layers | ST      | MT      | Speedup (ST/MT) |
|---------------------------|-------:|-------:|--------:|--------:|----------------:|
| Voron Design Cube v7      | 0.17 MB |   152 |   4.9 s |   3.7 s | **1.30×** |
| parcel-opener             | 2 MB   |    23 |   3.8 s |   2.2 s | **1.69×** |
| Rocket-Engine-MK4S        | 53 MB  |  1027 | 224.9 s | 194.4 s | 1.16× |
| Night Spirit (dragon)     | 135 MB |   147 | 203.9 s | 102.9 s | **1.98×** |

Every real model wins, from 1.16× to nearly 2×. On the 135 MB dragon, MT
**halves** a 3.4-minute slice.

## Why the speedup varies

The win tracks **how much of the slice is parallelizable geometry work versus
inherently serial work** — Amdahl's law in practice.

- **Geometric detail helps.** The dragon and parcel-opener are dense, curvy
  meshes: Arachne wall generation and path planning dominate, and oneTBB
  parallelizes that across regions/layers. Hence 1.69×–1.98×.
- **A big G-code tail hurts.** The Rocket engine is the heaviest *compute* here
  (1027 layers) yet only reaches 1.16× — because it emits **88 MB of G-code**,
  and serializing that text is a large single-threaded phase MT cannot speed
  up. The dragon, at the same absolute slice time, emits only 34.6 MB and so
  parallelizes far better.
- **Trivial geometry doesn't parallelize at all** — the cubes above.

## Takeaways

- **MT is worth it for real prints.** Its losses land on already-fast slices
  (sub-second cubes, where a couple hundred milliseconds is imperceptible); its
  wins land on the multi-second-to-multi-minute slices users actually wait on.
- **It is not a blanket win.** If per-model engine selection is ever added,
  gate MT on expected slice cost / model complexity rather than assuming it is
  always faster.
- MT only runs where the page is cross-origin isolated (COOP/COEP), i.e. the
  Cloudflare mirror — GitHub Pages always serves ST. See
  [ADR-011](adr/adr-011-multithreaded-engine.md).

## Reproducing

The engine binaries are the same ones the app loads (`public/wasm/slicer.*`
and `slicer-mt.*`). The measurements above were produced by loading each engine
via the marshalling in `orca-wasm/scripts/smoke-test.mjs` and timing repeated
`orc_slice` calls at the default preset — the ST/MT comparison harness
(`orca-wasm/scripts/compare-st-mt.mjs`) exercises the same path in CI to assert
the two engines produce equivalent G-code.
