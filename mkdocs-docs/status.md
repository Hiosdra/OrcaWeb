# Status — co działa, co nie działa

Ten dokument opisuje aktualny stan projektu: zaimplementowane funkcje, znane ograniczenia i planowane ulepszenia.

Ostatnia aktualizacja: **2026-06-13** · wersja silnika: **OrcaSlicer v2.3.2** (własny build, wdrożony na produkcji) · wersja aplikacji: **PR #14 merged**

---

## ✅ Działa

### Interfejs użytkownika

| Funkcja | Uwagi |
|---------|-------|
| Drag & drop pliku STL | ASCII i binary STL |
| Import pliku 3MF | Ekstrakcja siatki + profili OrcaSlicera z metadanych archiwum |
| Podgląd 3D modelu (Three.js) | Model na wirtualnym stole drukarskim w skali mm, OrbitControls |
| Siatka stołu — dynamiczny rozmiar | Rozmiar stołu pobierany z presetu drukarki lub profilu maszyny |
| Zakładki Model / Settings / Slice | Płynna nawigacja, zakładki zablokowane do momentu wczytania pliku |
| Panel ustawień | Wybór drukarki, filamentu, jakości |
| Podgląd G-code (warstwa po warstwie) | Slider warstw, kolorowanie wg warstwy, ciemne tło |
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
| Brak `slicer.data` | Headless flat-config slicer nie czyta `orca/resources` → plik danych zredukowany **200 MB → 0** |
| Singleton Worker | Jeden Worker przez cały czas sesji |
| Obsługa błędów | Kody błędów `-1`…`-9`, czytelne komunikaty |
| Wczytanie WASM gdy slicowanie w trakcie | Kolejkowanie żądania `SLICE` gdy WASM jeszcze się ładuje |
| JPEG miniatury G-code | Prawdziwy JPEG (RGBA→RGB, standard libjpeg) — od PR #13 |

### Override approach (engine clean layer)

| Aspekt | Szczegóły |
|--------|-----------|
| Brak modyfikacji kodu OrcaSlicer | Źródła C++ pozostają nienaruszone; stubs w `orca-wasm/overrides/` |
| Wyłączone zależności WASM | OCCT, OpenVDB, OpenCV, Draco, libnoise — zastąpione stubami |
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
| Release WASM `wasm-v2.3.2` | ✅ `slicer.js` + `slicer.wasm` (~9 MB łącznie) |
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
| Brak konfiguracji `bed_shape` | Bambu Lab P1S ma okrągły stół — kształt stołu nie jest wizualizowany w podglądzie 3D |
| Zakres temperatur niezweryfikowany | Presety printer+filament mogą być niespójne dla egzotycznych kombinacji |

### Podgląd G-code

| Problem | Szczegóły |
|---------|-----------|
| Tylko ruchy z ekstrudowaniem | Ruchy przejazdu (travel moves) nie są wizualizowane |
| Brak separacji typów ruchów | Nie rozróżniane: perimeter / infill / support / travel |

### Importowanie profili

| Problem | Szczegóły |
|---------|-----------|
| Mapowanie niekompletne | ~~Tylko ~30 pól z OrcaSlicera~~ Wszystkie pola trafiają do WASM (passthrough) — **naprawione w PR #14** |
| Profile maszyny ignorowane | ~~Pola z sekcji `machine_settings` nie są przekazywane do WASM~~ — **naprawione w PR #14** |

### Inne UI

| Problem | Szczegóły |
|---------|-----------|
| Brak wskaźnika postępu slicowania | Spinner bez informacji o etapie |
| Duże pliki STL (>50 MB) | Mogą powodować zacinanie się podczas podglądu |

---

## ❌ Nie zaimplementowane

### Formaty plików

| Funkcja | Priorytet |
|---------|-----------|
| OBJ import | 🟡 średni |
| STEP / IGES import | 🔴 nie możliwy — OCCT wyłączone (wymaga occt-wasm, blokada licencji LGPL-2.1-only) |
| Multi-plik (wiele STL naraz) | 🟡 średni |

### Zaawansowane funkcje slicowania

| Funkcja | Priorytet |
|---------|-----------|
| FuzzySkin (szorstkość powierzchni) | 🟡 średni — wymaga portu libnoise do WASM; aktualnie no-op |
| Variable layer height | 🟡 średni |
| Support enforcement / blocking | 🟡 średni |
| Multi-material | 🟠 niski |
| Multi-object na jednym stole | 🟡 średni |
| Auto-arrange | 🟡 średni |

### Podgląd G-code

| Funkcja | Priorytet |
|---------|-----------|
| Kolorowanie wg typu ruchu | 🔴 wysoki |
| Travel moves | 🟡 średni |

### Integracje

| Funkcja | Priorytet |
|---------|-----------|
| OctoPrint REST API | 🟡 średni |
| Bambu Lab wysyłanie | 🟠 niski (protokół proprietarny) |
| PWA / tryb offline | 🟡 średni |

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
      ── Kolorowanie G-code wg typu ruchu
      ── PWA / Service Worker

v0.4  ── OctoPrint integration
      ── Multi-object plate
      ── Variable layer height UI
```

---

## 🏗️ Architektura — status komponentów

```
src/
├── App.tsx                ✅ pełna logika UI, tabs, WASM orchestration, 3MF loading
├── components/
│   ├── FileUpload.tsx     ✅ drag & drop, STL + 3MF
│   ├── ModelViewer.tsx    ✅ Three.js, STLLoader, dynamiczny rozmiar stołu
│   ├── GcodeViewer.tsx    ✅ toolpaths, layer slider — ⚠️ brak travel
│   ├── SettingsPanel.tsx  ✅ presety, import profili — passthrough wszystkich pól OrcaSlicera
│   └── SlicePanel.tsx     ✅ progress states, statystyki G-code, download
├── lib/
│   ├── profiles.ts        ✅ presety z rozmiarami stołu, 30+ pól + passthrough wszystkich pozostałych
│   ├── parse3mf.ts        ✅ 3MF → binary STL + OrcaConfig
│   ├── wasm-loader.ts     ✅ orc_init / orc_slice / error codes
│   └── worker-singleton.ts ✅ singleton, preload WASM
├── workers/
│   └── slicer.worker.ts   ✅ WASM load + SLICE (brak chunk reassembly — slicer.data usunięty)
└── types/index.ts         ✅ OrcaConfig, GcodeStats, WorkerMessages, SliceStatus

orca-wasm/                 ✅ aktywny pipeline buildowy
├── bridge/slicer.cpp      ✅ orc_init / orc_slice bridge
├── wasm/                  ✅ CMakeLists, link flags, shims
├── wasm/shims/tbb/        ✅ sekwencyjne stuby TBB
├── overrides/             ✅ C++ stuby (OCCT/OpenVDB/OpenCV/Draco/FuzzySkin)
└── patches/apply.py       ✅ patcher CMake + bugfixów

public/wasm/               ✅ artefakty z release wasm-v2.3.2 (slicer.js + slicer.wasm)
CLI (cli/)                 ✅ działa lokalnie
```
