# 07 — Własny build WASM (OrcaSlicer v2.3.2)

**Status:** ✅ Build zielony na CI  
**Data:** 2026-06-12

## Cel

Zbudować silnik OrcaSlicer **v2.3.2** do WebAssembly we własnym pipeline
(`orca-wasm/`), zamiast korzystać z gotowych artefaktów z innego projektu —
tak aby OrcaWeb używał samodzielnie skompilowanego CLI v2.3.2.

## Wynik

Workflow `Build WASM` (`.github/workflows/build-wasm.yml`) kończy się sukcesem
i produkuje artefakty:

| Artefakt | Rozmiar |
|----------|---------|
| `slicer.wasm` | 7,3 MB |
| `slicer.js` | 1,5 MB |
| `slicer.data` (zasoby OrcaSlicer) | 200 MB |

## Pipeline budowania

1. **Emscripten** + zależności (`emsdk`).
2. **Zależności** budowane raz i cache'owane w `orca-wasm/deps-install/`:
   Boost 1.83 (b2, toolset emscripten, jednowątkowy), GMP/MPFR/CGAL,
   Eigen/nlohmann/EXPAT/NLopt/cereal, porty emscripten (zlib/png/jpeg).
3. **Checkout** OrcaSlicer v2.3.2.
4. **`orca-wasm/patches/apply.py`** — regexowe/brace-counting łatki nakładane na
   świeży checkout (patrz niżej).
5. **CMake + ninja** — build celu `slicer` z `SLIC3R_WASM=ON`.
6. **Pakowanie** artefaktów do `public/wasm/` i upload.

## Najważniejsze łatki WASM (apply.py + shims)

Większość to wyłączanie opcjonalnych zależności niepotrzebnych w przeglądarce
(guardy `SLIC3R_NO_OCCT` / `SLIC3R_NO_OPENVDB` / `SLIC3R_NO_OPENCV`):

- **OCCT** (STEP/SVG/TextShape) — stuby `.cpp` i guardy nagłówków.
- **OpenVDB** (`OpenVDBUtils.hpp`, `SLA/Hollowing.cpp`) — guard nagłówka i no-op
  stuby (hollowing SLA jest nieistotny dla slicera FDM).
- **OpenCV** (`ObjColorUtils`) — guard nagłówka + stub `.cpp`.
- **Draco** (`DRC.cpp`), **JPEG miniatury** (`Thumbnails.cpp` → fallback na PNG,
  bo libjpeg nie jest linkowany).
- **Platform.cpp** — pominięty `static_assert` o nieznanej platformie.
- **Shimy TBB** (`orca-wasm/wasm/shims/`) — sekwencyjne stuby: dodane
  `concurrent_unordered_set.h`, `parallel_for_each.h`, tagi partycjonerów
  (`simple/auto/static/affinity_partitioner`), `this_task_arena` wciągany przez
  `parallel_for.h`.

## Dwie nieoczywiste pułapki (kosztowały najwięcej)

1. **Namespace Boost.Log musi się zgadzać.** Nasz Boost zbudowany z
   `BOOST_LOG_NO_THREADS=1` → symbole w przestrzeni jednowątkowej `v2s_st`.
   Konsument (libslic3r) bez tego define'a odwołuje się do `v2s_mt_posix` i
   `wasm-ld` zgłasza setki `undefined symbol: boost::log::v2s_mt_posix::*`.
   Rozwiązanie: `BOOST_LOG_NO_THREADS=1` także dla konsumenta
   (`wasm_find_paths.cmake` + `CMAKE_CXX_FLAGS`). Skutek uboczny: brak
   `synchronous_sink` i `current_thread_id` — `utils.cpp` załatany na
   `unlocked_sink` i usunięcie pola `[Thread …]`.
2. **`-sEMULATE_FUNCTION_POINTER_CASTS=1` wywala wasm-opt.** Pass `--fpcast-emu`
   przy `-O3` powoduje SIGABRT Binaryena (`mixed_arena.h:188`). Sam link
   `wasm-ld` przechodzi — pada dopiero optymalizator. Flaga usunięta z
   `orca-wasm/wasm/CMakeLists.txt`.

## CI na PR-ach

`Build WASM` ma teraz trigger `pull_request` (filtrowany ścieżkami do
`orca-wasm/**` i pliku workflow), więc każdy push na branch PR-a automatycznie
uruchamia build jako check. Publikacja release'u jest pomijana na runach PR.

## Pozostałe / następne kroki

- Wygenerować release `wasm-v2.3.2` (run nie-PR: `workflow_dispatch` lub tag),
  który deploy.yml pobiera do produkcji.
- Zweryfikować w przeglądarce, że slicowanie faktycznie działa na silniku
  v2.3.2 (usunięcie `EMULATE_FUNCTION_POINTER_CASTS` jest bezpieczne tylko jeśli
  nie ma realnych niezgodnych wywołań przez wskaźnik — sprawdzić runtime).
