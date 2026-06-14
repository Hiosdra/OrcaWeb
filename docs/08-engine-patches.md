# 08 — Patche, overridy i shimy silnika OrcaSlicer

**Status:** ✅ Aktualny  
**Data:** 2026-06-14  
**Dotyczy:** OrcaSlicer v2.3.2 → build WASM (`orca-wasm/`)

## Przegląd

OrcaSlicer nie ma oficjalnego targetu WASM — cały pipeline wymaga własnych
poprawek nakładanych na świeży checkout submodułu.  Strategia jest trójwarstwowa:

| Warstwa | Lokalizacja | Kiedy stosowana |
|---------|-------------|-----------------|
| **Patche in-place** | `orca-wasm/patches/apply.py` | przy każdym CMake configure (CI + local) |
| **Override .cpp/.hpp** | `orca-wasm/overrides/` | zamiast oryginalnych plików zależnych od brakujących bibliotek |
| **Header shimy** | `orca-wasm/wasm/shims/` | podmiana TBB / OpenVDB / FreeType / OpenSSL przez `-isystem` |

Skrypt `apply.py` uruchamiany jest przed `cmake` i jest idempotentny (powtórne
wywołanie nie zmienia nic gdy łatki są już naniesione).  Tryb dry-run:
`python3 patches/apply.py --check`.

---

## 1. CMake — opcja `SLIC3R_WASM` i guardy zależności

**Plik:** `orca/CMakeLists.txt`

Dodana opcja `SLIC3R_WASM OFF` tuż po `project()`.  Wszystkie ciężkie zależności
GUI (wxWidgets, OpenGL, OCCT, OpenCV, draco, noise, fontconfig, FreeType) są
opakowane w `if(NOT SLIC3R_WASM)` lub warunek generatora
`$<$<NOT:$<BOOL:${SLIC3R_WASM}>>:…>`.  Dzięki temu budujemy tylko `libslic3r` +
nasz bridge, bez GUI i bez GUI-tylko zależności.

Dodatkowy fix: `cmake_policy(SET CMP0167 OLD)` — Boost jest budowany przez `b2`
i nie instaluje `BoostConfig.cmake`; legacy `FindBoost.cmake` (module mode) musi
być aktywny.

**Plik:** `orca/src/CMakeLists.txt`

Subdirectory GUI (`GUI`/`slic3r`/`OrcaSlicer`/`bambu_studio`) i `libnoise`
obwiedzione guardami `if(NOT SLIC3R_WASM)`.

**Plik:** `orca/src/libslic3r/CMakeLists.txt`

Definicje kompilacji `SLIC3R_WASM;SLIC3R_NO_OCCT;SLIC3R_NO_OPENVDB;SLIC3R_NO_OPENCV`
wstrzyknięte jako `PUBLIC` w `target_compile_definitions`.  Link do OCCT, OpenCV,
draco, OpenVDB, FreeType, fontconfig, noise — wszystkie obwiedzione guardami lub
generatorami.

---

## 2. Override — stub `.cpp` zamiast implementacji zależnych od brakujących bibliotek

Oryginalne pliki `.cpp` są oznaczane jako `HEADER_FILE_ONLY` (nie kompilowane)
i zastępowane stubami z `orca-wasm/overrides/`.  Każdy stub zwraca błąd
lub wartość zerową — zachowanie identyczne z tym, co widzi użytkownik WebAssembly
(te funkcje nigdy nie będą wywołane przez headless slicer FDM).

| Override plik | Zastępuje | Powód |
|---------------|-----------|-------|
| `Format/STEP.cpp` | import STEP/IGES | OCCT niedostępny w WASM |
| `Format/STEP.hpp` | nagłówek STEP | #include `<TopoDS_Shape.hxx>` wywołałby błąd kompilatora |
| `Format/DRC.cpp` | import Draco mesh | Draco niedostępny w WASM |
| `Format/svg.cpp` | eksport SVG | zależy od OCCT |
| `OpenVDBUtils.cpp` | VDB hollowing | OpenVDB niedostępny w WASM |
| `OpenVDBUtils.hpp` | nagłówek VDB | `#include <openvdb/…>` wywołałby błąd |
| `ObjColorUtils.cpp` | kalibracja kolorów OBJ | OpenCV niedostępny w WASM |
| `ObjColorUtils.hpp` | nagłówek OpenCV | `#include <opencv2/…>` wywołałby błąd |
| `SLA/Hollowing.cpp` | hollowing SLA | zależy od OpenVDB |
| `Shape/TextShape.cpp` | tekst 3D | zależy od FreeType + OCCT |
| `Feature/FuzzySkin/FuzzySkin.cpp` | fuzzy skin | może zależeć od libnoise |

> Nagłówki (`.hpp`) są **kopiowane bezpośrednio do drzewa `orca/`** (nie przez
> `-I`).  Kompilator przeszukuje katalog pliku włączającego przed ścieżkami `-I`,
> więc jedyną niezawodną metodą jest fizyczne zastąpienie pliku na miejscu.
> Kanoniczna treść stubów pozostaje w `orca-wasm/overrides/`.

---

## 3. Shimy nagłówkowe (`orca-wasm/wasm/shims/`)

Podawane przez `-isystem orca-wasm/wasm/shims/` — wyższy priorytet niż zainstalowane
nagłówki systemowe.

### TBB → sekwencyjne stuby

WASM jest jednowątkowy (SharedArrayBuffer nie jest wymagany); TBB API jest
zastępowane implementacjami działającymi sekwencyjnie w tym samym wątku.

| Shim | Semantyka |
|------|-----------|
| `tbb/parallel_for.h` (+ oneAPI mirror) | pętla `for` — funktor range lub index |
| `tbb/parallel_for_each.h` | `std::for_each` |
| `tbb/parallel_reduce.h` | iteracja sekwencyjna + merge |
| `tbb/parallel_invoke.h` | wywołanie wszystkich funktorów sekwencyjnie |
| `tbb/parallel_pipeline.h` | no-op (pipeline SLA nieużywany) |
| `tbb/task_arena.h` | `max_concurrency()` → 1; `execute()` wywołuje funktor |
| `tbb/task_group.h` | kolejkuje zadania, uruchamia w `wait()` |
| `tbb/spin_mutex.h` | no-op mutex (single-thread) |
| `tbb/partitioner.h` | puste typy `simple/auto/static/affinity_partitioner` |
| `tbb/global_control.h` | no-op |
| `tbb/concurrent_vector.h` | alias `std::vector` |
| `tbb/concurrent_unordered_map.h` | alias `std::unordered_map` |
| `tbb/concurrent_unordered_set.h` | alias `std::unordered_set` |
| `tbb/blocked_range.h` (+ `blocked_range2d.h`) | lekkie kontenery zakresu |
| `tbb/version.h` | stałe wersji |
| `oneapi/tbb/…` | przekierowania → `tbb/…` |

### OpenVDB → header stub

`openvdb/openvdb.h` — plik pusty z deklaracją namespace; kompilacja przechodzi,
linkowanie nie potrzebuje libopenvdb (pliki `.cpp` zastąpione overridami).

### FreeType → minimalne typy

`ft2build.h` + `freetype/*.h` — typy i stałe wymagane przez `Shape/TextShape.hpp`
(kod GUI — i tak nie trafia do buildu WASM, ale nagłówki są włączane przechodnio).

### OpenSSL MD5 → stub

`openssl/md5.h` — minimalny stub; Emscripten nie dostarcza OpenSSL, MD5 nie jest
używany w ścieżce krytycznej slicer FDM.

---

## 4. Patche in-place w kodzie C++ OrcaSlicer

Są to **bugfiksy kompatybilności** — rzeczy, które powinny być zgłoszone upstream.
Nakładane regexowo przez `apply.py`.

### 4.1 `GCode.hpp` — narrowing na 32-bit WASM

```
src/libslic3r/GCode.hpp
```

`LayerResult::make_nop_layer_result` inicjalizuje pole `size_t` wartością
`std::numeric_limits<coord_t>::max()` (`INT64_MAX`).  Na 32-bit WASM (`size_t` =
`uint32_t`) jest to zawężenie zakazane przez standard C++11 (`-Wc++11-narrowing`).

**Fix:** `static_cast<size_t>(-1)` — niezależny od platformy maksymalny sentinel.

### 4.2 `Model.cpp` — guard `read_from_step()`

```
src/libslic3r/Model.cpp
```

Override `STEP.cpp` definiuje własną `Model::read_from_step()`.  Oryginalny plik
zawiera pełną implementację opartą na OCCT — oba symbole powodują błąd linkera.

**Fix:** oryginalne ciało funkcji obwiedzione `#ifndef SLIC3R_NO_OCCT … #endif`
przez brace-counting parser w `apply.py`.

### 4.3 `AABBTreeLines.hpp` — dedukcja szablonu Eigen

```
src/libslic3r/AABBTreeLines.hpp
```

`origin.cast<Scalar>()` zwraca `CwiseUnaryOp` (wyrażenie leniwe), które nie
dopasowuje się do `Eigen::Matrix` przy dedukcji szablonu argumentu.

**Fix:** `decltype(nearest_point)(origin.cast<Scalar>())` — explicit konstruktor.

### 4.4 `Platform.cpp` — nieznana platforma Emscripten

```
src/libslic3r/Platform.cpp
```

`static_assert(false, "Unknown platform detected")` — Emscripten nie należy do
listy znanych platform OrcaSlicer.

**Fix:** obwiedzenie guardami `#ifndef SLIC3R_WASM … #endif`.

### 4.5 `GCode/Thumbnails.cpp` — libjpeg-turbo → standard IJG

```
src/libslic3r/GCode/Thumbnails.cpp
```

OrcaSlicer używa `JCS_EXT_RGBA` (rozszerzenie libjpeg-turbo, wartość 13) jako
przestrzeń kolorów wejściowych dla miniatury JPEG z kanałem alfa.  Emscripten
dostarcza standardową IJG libjpeg (`embuilder build libjpeg`), która tego
rozszerzenia nie obsługuje — kompresja kończyłaby się błędem runtime.

**Dwa kroki:**
1. `#define JCS_EXT_RGBA ((J_COLOR_SPACE)13)` po `#include <jpeglib.h>` —
   kompilacja przechodzi (wartość liczbowa jest dostępna).
2. Cała funkcja `compress_thumbnail_jpg` zastąpiona implementacją
   konwertującą RGBA → RGB (odwrócone wiersze + pominięcie kanału alfa),
   po czym kompresja z `JCS_RGB` przez standardowe API IJG.

### 4.6 `utils.cpp` — Boost.Log single-thread

```
src/libslic3r/utils.cpp
```

Boost.Log zbudowany z `BOOST_LOG_NO_THREADS=1` eksportuje symbole w przestrzeni
`v2s_st` zamiast `v2s_mt_posix`.  Domyślna kompilacja `libslic3r` odnosi się do
`synchronous_sink` i `expr::attr<current_thread_id>`, które nie istnieją w buildie
jednowątkowym.

**Dwa regex:**
- `synchronous_sink` → `unlocked_sink`
- całe wyrażenie `<< "[Thread " << expr::attr<…>("ThreadID") << "]"` → usunięte

Ten sam define (`BOOST_LOG_NO_THREADS=1`) musi być przekazany do całego buildu
libslic3r przez `wasm_find_paths.cmake` + `CMAKE_CXX_FLAGS` — bez tego linker
zgłasza setki `undefined symbol: boost::log::v2s_mt_posix::*`.

---

## 5. Dwie nieoczywiste pułapki

### 5.1 Namespace Boost.Log (`v2s_st` vs `v2s_mt_posix`)

**Symptom:** setki `undefined symbol: boost::log::v2s_mt_posix::*` z `wasm-ld`.

**Przyczyna:** Boost zbudowany z `BOOST_LOG_NO_THREADS=1` emituje symbole w
przestrzeni `v2s_st` (single-thread).  Konsument (`libslic3r`) bez tego define'a
szuka przestrzeni `v2s_mt_posix` — ABI mismatch.

**Rozwiązanie:** `BOOST_LOG_NO_THREADS=1` musi być zdefiniowany **zarówno przy
budowaniu Boost jak i przy budowaniu libslic3r**.  Patch 4.6 (`utils.cpp`)
usuwa wywołania do `synchronous_sink` i `current_thread_id`, które nie istnieją
w MT-modefix Boost.

### 5.2 `-sEMULATE_FUNCTION_POINTER_CASTS=1` wywala `wasm-opt`

**Symptom:** SIGABRT w `mixed_arena.h:188` (Binaryen) podczas przebiegu `--fpcast-emu`
przy optymalizacji `-O3`.  Sam link (`wasm-ld`) przechodzi bez błędu.

**Przyczyna:** pass `--fpcast-emu` Binaryena crashuje przy `-O3` (znany bug).

**Rozwiązanie:** flaga usunięta z `orca-wasm/wasm/CMakeLists.txt`.  WASM instancjuje
i slicuje poprawnie bez emulatora rzutowania wskaźników — żadne trapy runtime
nie były obserwowane w testach.

---

## 6. Wstrzyknięcie bridge i link target

`apply.py` dopisuje na końcu `orca/CMakeLists.txt` blok:

```cmake
if(SLIC3R_WASM AND DEFINED ORCA_WEB_BRIDGE_DIR)
  set(ORCA_SRC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  add_subdirectory("${ORCA_WEB_BRIDGE_DIR}" bridge)
  add_subdirectory("${ORCA_WEB_WASM_DIR}"   wasm)
endif()
```

Zmienne `ORCA_WEB_BRIDGE_DIR` i `ORCA_WEB_WASM_DIR` są przekazywane przez
`scripts/build.sh` jako `-D` argumenty do `cmake`.  Efekt: bridge (`slicer.cpp`)
i cel Emscripten (`wasm/CMakeLists.txt` produkujący `slicer.js` + `slicer.wasm`)
są częścią tego samego drzewa CMake co `libslic3r`, ale ich kod źródłowy nigdy
nie trafia do submodułu `orca/`.

---

## 7. Dodawanie nowej łatki

1. **Bugfix C++** (narrowing, dedukcja, assert, ABI) → dodaj tuple do funkcji
   `patch()` w odpowiedniej sekcji `apply.py`.
2. **Stub `.cpp`** (wyłączenie funkcji zależnej od brakującej biblioteki) →
   utwórz `orca-wasm/overrides/src/libslic3r/<path>.cpp`, dodaj oryginał do
   `_wasm_orig_stubs` i override do `target_sources` w sekcji 4c `apply.py`.
3. **Stub nagłówka** (`#include` wyciąga zewnętrzną bibliotekę) →
   utwórz `orca-wasm/overrides/src/libslic3r/<path>.hpp`, dodaj
   `copy_override("src/libslic3r/<path>.hpp")` w sekcji 4b `apply.py`.
4. **Nowy shim nagłówkowy** (nowe API TBB / OpenSSL / itd.) →
   dodaj plik do `orca-wasm/wasm/shims/` — jest on automatycznie brany przez
   `-isystem` zdefiniowane w `wasm/CMakeLists.txt`.

Po zmianie uruchom `python3 orca-wasm/patches/apply.py --check` żeby
zweryfikować bez modyfikacji plików.
