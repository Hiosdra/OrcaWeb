# Status — co działa, co nie działa

Ten dokument opisuje aktualny stan projektu: zaimplementowane funkcje, znane ograniczenia i planowane ulepszenia.

Ostatnia aktualizacja: **2026-07-05** · wersja silnika: **OrcaSlicer v2.4.0** (własny build, wdrożony na produkcji) · wersja aplikacji: **v0.7.5**

---

## ✅ Działa

### Interfejs użytkownika

| Funkcja | Uwagi |
|---------|-------|
| Drag & drop pliku STL | ASCII i binary STL; wiele plików naraz — kolejka sekwencyjna, każdy G-code do pobrania osobno |
| Import pliku 3MF | Ekstrakcja siatki + profili OrcaSlicera z metadanych archiwum |
| Import OBJ | Konwersja OBJ → STL przez natywny parser OrcaSlicer (`objparser.cpp` + `OBJ.cpp`) skompilowany w WASM — bez dodatkowych zależności; obsługuje trójkąty, quady, multi-obiekt |
| Import STEP | Konwersja STEP → STL przez OCCT 7.8.1 wkompilowane bezpośrednio w `slicer.wasm` (`Model::read_from_step`); bez osobnego pobierania. IGES nieobsługiwane (czytnik STEP OrcaSlicera nie obsługuje IGES) |
| Podgląd 3D modelu (Three.js) | Model na wirtualnym stole drukarskim w skali mm, OrbitControls |
| Siatka stołu — dynamiczny rozmiar | Rozmiar stołu pobierany z presetu drukarki lub profilu maszyny |
| Kształt stołu (`bed_shape`) | Prostokątny lub okrągły (np. Bambu Lab P1S); wizualizacja w podglądzie 3D i G-code |
| FuzzySkin (szorstkość powierzchni) | Tryby: none / external (tylko zewnętrzne ściany) / all; grubość 0.05–2 mm, rozstaw punktów 0.1–5 mm; libnoise skompilowane dla WASM (Perlin/Billow/RidgedMulti/Voronoi) — od PR #32 |
| Multi-plik — kolejka sekwencyjna | Drag & drop wielu plików → każdy slice osobno, własny G-code do pobrania |
| Multi-plik — jeden stół (One plate) | Przycisk „One plate (N)" → wszystkie STL auto-ułożone przez `arrange_objects()` (libnest2d), jeden G-code |
| Zakładki Model / Settings / Slice | Płynna nawigacja, zakładki zablokowane do momentu wczytania pliku |
| Panel ustawień | Wybór drukarki, filamentu, jakości |
| Podgląd G-code (warstwa po warstwie) | Slider warstw, kolorowanie wg typu ruchu (perimeter/infill/support/travel), grube linie 3D, kursor warstwy — od PR #16 |
| Statystyki G-code | Czas druku, warstwy, filament (mm/g), rozmiar pliku — parsowane z nagłówka G-code |
| Widok model + G-code obok siebie | Po slicowaniu — synchronizowany układ obok siebie |
| Pobieranie G-code | Przycisk „Download .gcode" z poprawną nazwą pliku |
| Status silnika (badge) | „Loading engine…" / „Engine error" w nagłówku |
| Wersja silnika w nagłówku | `v{app} · {data} · engine v{orca}` pod logo — ten sam tekst na każdej szerokości ekranu (mobile/tablet/desktop) |
| Stopka — link do źródeł (AGPL) | Widoczny link „Source (AGPL-3.0)" → repo GitHub |

### Silnik WASM

| Funkcja | Uwagi |
|---------|-------|
| Slicowanie STL → G-code | W Web Workerze, nie blokuje UI |
| Własny build OrcaSlicer **v2.4.0** | Zbudowany przez `orca-wasm/` + Emscripten; artefakty w release `wasm-v2.4.0` |
| `orc_obj_to_stl` | Nowy eksport WASM: konwersja OBJ → binary STL bez potrzeby `orc_init`; wynik zwracany jako `ArrayBuffer` do workera |
| `orc_slice_multi` | Wiele STL → jeden G-code: auto-arrange przez `arrange_objects()` (libnest2d + NLopt); wynik identyczny jak `orc_slice` |
| Brak `slicer.data` | Headless flat-config slicer nie czyta `orca/resources` → plik danych zredukowany **200 MB → 0** |
| Singleton Worker | Jeden Worker przez cały czas sesji |
| Obsługa błędów | Kody błędów `-1`…`-9`, czytelne komunikaty |
| Wczytanie WASM gdy slicowanie w trakcie | Kolejkowanie żądania `SLICE` gdy WASM jeszcze się ładuje |
| JPEG miniatury G-code | Prawdziwy JPEG (RGBA→RGB, standard libjpeg) — od PR #13 |
| Licznik czasu slicowania | Przycisk pokazuje `Slicing… (12s)` — rzetelna informacja bez fikcyjnych etapów — od PR #15 |
| PWA / tryb offline | Service Worker (Workbox) pre-cache'uje wszystkie assety + WASM przy pierwszej wizycie; instalacja jako aplikacja natywna |
| Silnik sesyjny (`orc_session_create`/`orc_session_destroy`) | Stan silnika (config, bed, last error) przeniesiony z globalnych statyków C++ do uchwytu sesji — patrz [ADR-008](adr/adr-008-session-handle.md) |
| Odzyskiwanie po awarii WASM | `onAbort` realnie zgłasza `WASM_ERROR` do głównego wątku; martwy Worker jest odrzucany i zastępowany świeżym przy kolejnej próbie |
| Smoke test silnika w CI | `orca-wasm/scripts/smoke-test.mjs` — realny `orc_init`/`orc_slice(_multi)` po każdym buildzie, przed publikacją release'u — patrz [ADR-009](adr/adr-009-wasm-smoke-test.md) |

### Override approach (engine clean layer)

| Aspekt | Szczegóły |
|--------|-----------|
| Brak modyfikacji kodu OrcaSlicer | Źródła C++ pozostają nienaruszone; stubs w `orca-wasm/overrides/` |
| Wyłączone zależności WASM | OCCT, OpenVDB, OpenCV, Draco — zastąpione stubami; libnoise skompilowane dla WASM |
| Aktualizacja do nowej wersji | Tylko `ORCA_VERSION` w workflow + ewentualna korekta stubów |
| Zgodność AGPL-3.0 | `LICENSE`, `NOTICE.md`, link do źródeł w UI — `§13` network copyleft spełniony |

### Profile OrcaSlicera

| Funkcja | Uwagi |
|---------|-------|
| Wbudowane presety jakości | Draft (0.3 mm) / Standard (0.2 mm) / Fine (0.1 mm) |
| Wbudowane filamenty | PLA, PETG, ABS, TPU |
| Wbudowane drukarki | Generic 0.4/0.6, Bambu Lab P1S/X1C, Prusa MK4, Ender 3, Voron 2.4 |
| Import profilu JSON z OrcaSlicera | Plik `.json` z instalacji desktop; mapowanie `ORCA_FIELD_MAP` + passthrough wszystkich pozostałych pól |
| Import profilu maszyny | Pola `gcode_flavor`, `retract_length/speed`, `lift_z`, `machine_start/end_gcode`, `machine_max_speed_*`, `printable_height` — wszystkie trafiają do silnika |
| Ekstrakcja profili z 3MF | `Metadata/*.json/.config` z archiwum |

### Deployment

| Aspekt | Status |
|--------|--------|
| GitHub Actions CI (deploy.yml) | ✅ buduje i deployuje na każdy push do `master` |
| Serwowanie WASM z tej samej origin | ✅ brak CORS — pliki w `gh-pages/app/wasm/` |
| Release WASM `wasm-v2.4.0` | ✅ `slicer.js` + `slicer.wasm` (~29 MB łącznie, z OCCT STEP) |
| Deploy resilience | ✅ fallback na poprzedni `gh-pages` gdy release nie istnieje |
| CI build na PRach (ścieżki orca-wasm/) | ✅ każdy PR dotykający silnika uruchamia ~12 min build |
| Auto-bump wersji aplikacji | ✅ każdy deploy sam podbija patch w `package.json`/`status.md` i taguje `vX.Y.Z` — bez ręcznej edycji (patrz `/release` tylko dla świadomego minor/major) |
| Auto-rebuild silnika po zmianie `orca-wasm/` | ✅ push na `master` dotykający `orca-wasm/**` sam odpala `build-wasm.yml`; `deploy.yml` czeka na jego wynik (`workflow_run`) zamiast ścigać się ze starym silnikiem |
| Strona promująca (landing) | ✅ `hiosdra.github.io/OrcaWeb/` |
| Dokumentacja MkDocs | ✅ `hiosdra.github.io/OrcaWeb/docs/` |
| Dependabot + grupowanie zależności | ✅ tygodniowy harmonogram |

---

## ⚠️ Częściowo działa / znane ograniczenia

### Ustawienia drukarki

| Problem | Szczegóły |
|---------|-----------|
| Zakres temperatur niezweryfikowany | Presety printer+filament mogą być niespójne dla egzotycznych kombinacji |

### Importowanie profili

| Problem | Szczegóły |
|---------|-----------|
| Mapowanie niekompletne | ~~Tylko ~30 pól z OrcaSlicera~~ Wszystkie pola trafiają do WASM (passthrough) — **naprawione w PR #14** |
| Profile maszyny ignorowane | ~~Pola z sekcji `machine_settings` nie są przekazywane do WASM~~ — **naprawione w PR #14** |

### Inne UI

| Problem | Szczegóły |
|---------|-----------|
| Duże pliki STL (>50 MB) | Mogą powodować zacinanie się podczas podglądu |

### Multi-ekstruder / multi-material

Bridge udostępnia teraz `orc_slice_multi`'s `extruder_ids` — per-obiektowe przypisanie do klucza konfiguracyjnego OrcaSlicera `"extruder"` (`ModelConfig::set`, `PrintConfig.cpp`), które silnik i tak już normalizuje do `*_filament_id` (`normalize_fdm()`). To jest ścieżka "jedna dysza, wiele slotów filamentu" (AMS-style) — **nie** dotyka `nozzle_diameter`, więc nie wchodzi w kod `support_different_extruders()` odpowiedzialny za wcześniej potwierdzony crash na prawdziwym profilu Bambu Lab H2D (patrz `isMultiExtruderProfile()` w `src/lib/profiles.ts` i [ADR-008](adr/adr-008-session-handle.md)).

| Element | Status |
|---------|--------|
| Bridge: `orc_slice_multi(..., extruder_ids, ...)` | ✅ zaimplementowane, zweryfikowane przez smoke test (scenariusz "plate: 2 objects, per-object extruder override") |
| Prawdziwe drukarki wielo-dyszowe (`nozzle_diameter` > 1 wpis) + UI do przypisania ekstrudera/filamentu per obiekt w kolejce | ❌ świadomie zablokowane — `isMultiExtruderProfile()` odrzuca passthrough takich profili; wymaga debug builda WASM (`-O0 -g`) i sesji root-cause, której nie da się przeprowadzić bez lokalnego toolchaina Emscripten. UI nie ma sensu budować przed odblokowaniem silnika |

---

## ❌ Nie zaimplementowane

### Zaawansowane funkcje slicowania

| Funkcja | Priorytet |
|---------|-----------|
| Variable layer height | 🟡 średni |
| Support enforcement / blocking | 🟡 średni |

---

## 🗺️ Roadmap

```
v0.1  ── ✅ STL import, 3D viewer, slicing, G-code viewer, download
      ── ✅ Preset quality / filament / printer profiles
      ── ✅ JSON profile import from OrcaSlicer

v0.2  ── ✅ 3MF import (mesh + embedded profile extraction)
      ── ✅ Per-printer bed size
      ── ✅ Statystyki G-code

v0.3  ── ✅ Własny build WASM v2.4.0 (bez slicer.data)
      ── ✅ AGPL-3.0 compliance
      ── ✅ Override approach (engine clean layer)
      ── ✅ Prawdziwy JPEG (PR #13)
      ── ✅ Import pełnych profili maszyny z OrcaSlicera (PR #14)
      ── ✅ Licznik czasu slicowania (PR #15)
      ── ✅ Kolorowanie G-code wg typu ruchu, travel moves, grube linie 3D (PR #16)
      ── ✅ PWA / Service Worker — pre-cache WASM przy pierwszej wizycie
      ── ✅ Import STEP (OCCT 7.8.1 wkompilowane w silnik, `Model::read_from_step`; zastępuje occt-import-js z PR #19)

v0.4  ── ✅ Import OBJ (natywny parser OrcaSlicer w WASM, `orc_obj_to_stl`)
      ── ✅ bed_shape — okrągły stół (P1S) wizualizowany w podglądzie 3D i G-code
      ── ✅ FuzzySkin UI — none/external/all, thickness + point_dist (PR #32)
      ── ✅ Multi-object plate — „One plate (N)" auto-arrange przez `orc_slice_multi`
      ── ✅ Presety drukarek/filamentów/jakości pobrane z prawdziwych profili OrcaSlicer (resources/profiles/) zamiast ręcznie wpisanych wartości
      ── Variable layer height UI

      ── ✅ Sesyjny stan silnika — orc_session_create/destroy zamiast globalnych statyków C++ (ADR-008)
      ── ✅ Odzyskiwanie po awarii WASM — worker martwy po abort() jest odrzucany i zastępowany
      ── ✅ Smoke test silnika w CI — realny orc_init/orc_slice(_multi) po każdym buildzie (ADR-009)
      ── ✅ Bridge: per-obiektowe przypisanie ekstrudera/filamentu (orc_slice_multi extruder_ids) — jedna dysza, wiele slotów filamentu
      ── Prawdziwe drukarki wielo-dyszowe — zablokowane do czasu root-cause session z debug buildem WASM
```

---

## 🏗️ Architektura — status komponentów

```
src/
├── App.tsx                ✅ kolejka wieloplikowa + tryb "one plate"; WASM orchestration, 3MF loading
├── components/
│   ├── FileUpload.tsx     ✅ drag & drop multi-file, STL + 3MF + OBJ + STEP, kolejka sekwencyjna
│   ├── ModelViewer.tsx    ✅ Three.js, STLLoader, dynamiczny rozmiar stołu, okrągły stół (bed_shape)
│   ├── GcodeViewer.tsx    ✅ toolpaths, layer slider, feature-type colors, travel moves, grube linie 3D, okrągły stół
│   ├── SettingsPanel.tsx  ✅ presety, import profili — passthrough wszystkich pól OrcaSlicera
│   └── SlicePanel.tsx     ✅ progress states, statystyki G-code, download
├── lib/
│   ├── profiles.ts        ✅ presety z rozmiarami + kształtem stołu, 30+ pól + passthrough wszystkich pozostałych
│   ├── parse3mf.ts        ✅ 3MF → binary STL + OrcaConfig
│   ├── wasm-loader.ts     ✅ sesja (orc_session_create/destroy) + orc_init / orc_slice / orc_slice_multi (extruder_ids) / orc_obj_to_stl / orc_cad_to_stl (STEP) / error codes
│   └── worker-singleton.ts ✅ singleton, preload WASM, drop+respawn workera po WASM_ERROR
├── workers/
│   └── slicer.worker.ts   ✅ WASM load + tworzenie sesji + SLICE + SLICE_MULTI + OBJ_TO_STL
└── types/index.ts         ✅ OrcaConfig, GcodeStats, WorkerMessages, SliceStatus

orca-wasm/                 ✅ aktywny pipeline buildowy
├── bridge/slicer.cpp      ✅ orc_session_create/destroy + orc_init / orc_slice / orc_slice_multi / orc_obj_to_stl bridge
├── scripts/smoke-test.mjs ✅ post-build regression test (patrz ADR-009)
├── wasm/                  ✅ CMakeLists, link flags, shims
├── wasm/shims/tbb/        ✅ sekwencyjne stuby TBB
├── overrides/             ✅ C++ stuby (OCCT/OpenVDB/OpenCV/Draco)
└── patches/apply.py       ✅ patcher CMake + bugfixów

public/wasm/               ✅ artefakty z release wasm-v2.4.0 (slicer.js + slicer.wasm)
```

Brak katalogu `cli/` jest świadomy — CLI zostało zaimplementowane, a następnie w całości usunięte (`chore: remove CLI` — frontend → bridge → engine only). Nie jest to cel projektu.
