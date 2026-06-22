# Status — co działa, co nie działa

Ten dokument opisuje aktualny stan projektu: zaimplementowane funkcje, znane ograniczenia i planowane ulepszenia.

Ostatnia aktualizacja: **2026-06-20** · wersja silnika: **OrcaSlicer v2.3.2** (własny build, wdrożony na produkcji) · wersja aplikacji: **v0.4.0**

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
| Stopka — link do źródeł (AGPL) | Widoczny link „Source (AGPL-3.0)" → repo GitHub |

### Silnik WASM

| Funkcja | Uwagi |
|---------|-------|
| Slicowanie STL → G-code | W Web Workerze, nie blokuje UI |
| Własny build OrcaSlicer **v2.3.2** | Zbudowany przez `orca-wasm/` + Emscripten; artefakty w release `wasm-v2.3.2` |
| `orc_obj_to_stl` | Nowy eksport WASM: konwersja OBJ → binary STL bez potrzeby `orc_init`; wynik zwracany jako `ArrayBuffer` do workera |
| `orc_slice_multi` | Wiele STL → jeden G-code: auto-arrange przez `arrange_objects()` (libnest2d + NLopt); wynik identyczny jak `orc_slice` |
| Brak `slicer.data` | Headless flat-config slicer nie czyta `orca/resources` → plik danych zredukowany **200 MB → 0** |
| Singleton Worker | Jeden Worker przez cały czas sesji |
| Obsługa błędów | Kody błędów `-1`…`-9`, czytelne komunikaty |
| Wczytanie WASM gdy slicowanie w trakcie | Kolejkowanie żądania `SLICE` gdy WASM jeszcze się ładuje |
| JPEG miniatury G-code | Prawdziwy JPEG (RGBA→RGB, standard libjpeg) — od PR #13 |
| Licznik czasu slicowania | Przycisk pokazuje `Slicing… (12s)` — rzetelna informacja bez fikcyjnych etapów — od PR #15 |
| PWA / tryb offline | Service Worker (Workbox) pre-cache'uje wszystkie assety + WASM przy pierwszej wizycie; instalacja jako aplikacja natywna |

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

### CLI (Node.js)

| Komenda | Status |
|---------|--------|
| `npm run cli -- slice <plik.stl>` | ✅ działa |
| `npm run cli -- profiles` | ✅ działa |
| Opcje `--preset`, `--printer`, `--filament` | ✅ działa |

### Deployment

| Aspekt | Status |
|--------|--------|
| GitHub Actions CI (deploy.yml) | ✅ buduje i deployuje na każdy push do `master` |
| Serwowanie WASM z tej samej origin | ✅ brak CORS — pliki w `gh-pages/app/wasm/` |
| Release WASM `wasm-v2.3.2` | ✅ `slicer.js` + `slicer.wasm` (~29 MB łącznie, z OCCT STEP) |
| Deploy resilience | ✅ fallback na poprzedni `gh-pages` gdy release nie istnieje |
| CI build na PRach (ścieżki orca-wasm/) | ✅ każdy PR dotykający silnika uruchamia ~12 min build |
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

---

## ❌ Nie zaimplementowane

### Zaawansowane funkcje slicowania

| Funkcja | Priorytet |
|---------|-----------|
| Variable layer height | 🟡 średni |
| Support enforcement / blocking | 🟡 średni |
| Multi-material | 🟠 niski |
| Auto-arrange | 🟡 średni |

---

## 🗺️ Roadmap

```
v0.1  ── ✅ STL import, 3D viewer, slicing, G-code viewer, download
      ── ✅ Preset quality / filament / printer profiles
      ── ✅ JSON profile import from OrcaSlicer

v0.2  ── ✅ 3MF import (mesh + embedded profile extraction)
      ── ✅ Per-printer bed size
      ── ✅ Statystyki G-code

v0.3  ── ✅ Własny build WASM v2.3.2 (bez slicer.data)
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
      ── Variable layer height UI
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
│   ├── wasm-loader.ts     ✅ orc_init / orc_slice / orc_slice_multi / orc_obj_to_stl / orc_cad_to_stl (STEP) / error codes
│   └── worker-singleton.ts ✅ singleton, preload WASM
├── workers/
│   └── slicer.worker.ts   ✅ WASM load + SLICE + SLICE_MULTI + OBJ_TO_STL
└── types/index.ts         ✅ OrcaConfig, GcodeStats, WorkerMessages, SliceStatus

orca-wasm/                 ✅ aktywny pipeline buildowy
├── bridge/slicer.cpp      ✅ orc_init / orc_slice / orc_slice_multi / orc_obj_to_stl bridge
├── wasm/                  ✅ CMakeLists, link flags, shims
├── wasm/shims/tbb/        ✅ sekwencyjne stuby TBB
├── overrides/             ✅ C++ stuby (OCCT/OpenVDB/OpenCV/Draco)
└── patches/apply.py       ✅ patcher CMake + bugfixów

public/wasm/               ✅ artefakty z release wasm-v2.3.2 (slicer.js + slicer.wasm)
CLI (cli/)                 ✅ działa lokalnie
```
