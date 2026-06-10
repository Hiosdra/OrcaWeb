# Status — co działa, co nie działa

Ten dokument opisuje aktualny stan projektu: zaimplementowane funkcje, znane ograniczenia i planowane ulepszenia.

Ostatnia aktualizacja: **2026-06-10** · wersja silnika: **OrcaSlicer v2.3.1** (własny build v2.3.2 w toku — CI iteracyjnie naprawiany)

---

## ✅ Działa

### Interfejs użytkownika

| Funkcja | Uwagi |
|---------|-------|
| Drag & drop pliku STL | ASCII i binary STL |
| Podgląd 3D modelu (Three.js) | Model na wirtualnym stole drukarskim w skali mm, OrbitControls |
| Siatka stołu 250×250 mm | Widoczna siatka pomocnicza i obramowanie |
| Zakładki Model / Settings / Slice | Płynna nawigacja, zakładki zablokowane do momentu wczytania pliku |
| Panel ustawień | Wybór drukarki, filamentu, jakości |
| Podgląd G-code (warstwa po warstwie) | Slider warstw, kolorowanie wg warstwy, ciemne tło |
| Widok model + G-code obok siebie | Po slicowaniu — synchronizowany układ obok siebie |
| Pobieranie G-code | Przycisk „Download .gcode" z poprawną nazwą pliku |
| Status silnika (badge) | „Loading engine…" / „Engine error" w nagłówku |

### Silnik WASM

| Funkcja | Uwagi |
|---------|-------|
| Slicowanie STL → G-code | W Web Workerze, nie blokuje UI |
| Singleton Worker | Jeden Worker przez cały czas sesji — `slicer.data` ładowany tylko raz |
| Obsługa błędów | Kody błędów `-1`…`-9`, czytelne komunikaty dla użytkownika |
| Wczytanie WASM gdy slicowanie w trakcie | Kolejkowanie żądania `SLICE` gdy WASM jeszcze się ładuje |

### Profile OrcaSlicera

| Funkcja | Uwagi |
|---------|-------|
| Wbudowane presety jakości | Draft (0.3 mm) / Standard (0.2 mm) / Fine (0.1 mm) |
| Wbudowane filamenenty | PLA, PETG, ABS, TPU — temperatury i prędkości wentylatorów |
| Wbudowane drukarki | Generic 0.4/0.6, Bambu Lab P1S/X1C, Prusa MK4, Creality Ender 3, Voron 2.4 |
| Import profilu JSON z OrcaSlicera | Plik `.json` z instalacji desktop; mapowanie `ORCA_FIELD_MAP` — 30+ pól |
| Obsługa array-wrapped values | `["0.2"]` → `0.2` (format OrcaSlicera) |
| Obsługa wartości procentowych | `"15%"` → `15`, `"0.15"` → `15` |

### CLI (Node.js)

| Komenda | Status |
|---------|--------|
| `npm run cli -- slice <plik.stl>` | ✅ działa |
| `npm run cli -- profiles` | ✅ działa |
| Opcje `--preset`, `--printer`, `--filament` | ✅ działa |
| `node scripts/download-wasm.mjs` | ✅ działa |

### Deployment

| Aspekt | Status |
|--------|--------|
| GitHub Actions CI (deploy.yml) | ✅ buduje i deployuje na każdy push do `master` |
| Serwowanie WASM z tej samej origin | ✅ brak CORS — pliki w `gh-pages/app/wasm/` |
| Dzielenie `slicer.data` na chunki | ✅ 2× ≈72 MB, transparentne scalanie w workerze |
| Strona promująca (landing) | ✅ `hiosdra.github.io/OrcaWeb/` |
| Dokumentacja MkDocs | ✅ `hiosdra.github.io/OrcaWeb/docs/` |
| Favicon `orca.svg` | ✅ |
| Dependabot + grupowanie zależności | ✅ tygodniowy harmonogram, 5 grup |

---

## ⚠️ Częściowo działa / znane ograniczenia

### Silnik WASM — wersja

!!! warning "Używana wersja: v2.3.1"
    Aktualnie deployowane artefakty WASM (`slicer.js`, `slicer.wasm`, `slicer.data`)
    pochodzą z zewnętrznego projektu `allanwrench28/orcaslicer-wasm` v1.1
    (OrcaSlicer v2.3.1).
    
    Własny build v2.3.2 jest w toku w `orca-wasm/`.
    Infrastruktura buildowa jest naprawiana iteracyjnie; każdy run CI odsłania
    kolejny błąd (na razie: naprawiony git-clone, cmake context, brakujące paczki).
    Aby uruchomić build: Actions → **Build WASM** → Run workflow (~60–120 min).

### Ustawienia drukarki

| Problem | Szczegóły |
|---------|-----------|
| Stół hardcoded na 250×250 mm | `ModelViewer` i podgląd G-code zakładają 250×250 mm, niezależnie od wybranej drukarki |
| Brak konfiguracji `bed_shape` | Bambu Lab P1S ma okrągły stół — nie jest to przekazywane do WASM |
| Zakres temperatur niezweryfikowany | Presety printer+filament mogą być niespójne dla egzotycznych kombinacji |

### Podgląd G-code

| Problem | Szczegóły |
|---------|-----------|
| Tylko ruchy z ekstrudowaniem | Ruchy przejazdu (travel moves) nie są wizualizowane |
| Brak separacji typów ruchów | Nie rozróżniane: perimeter / infill / support / travel |
| Brak statystyk G-code | Brak czasu druku, zużycia filamentu, liczby warstw |
| Centrowanie toolpathów | Centroid G-code może nie pokrywać się idealne z modelem dla bardzo niecentrycznych kształtów |

### Importowanie profili

| Problem | Szczegóły |
|---------|-----------|
| Mapowanie niekompletne | Tylko ~30 pól z OrcaSlicera. Brakuje m.in.: `support_interface_*`, `ironing_*`, `seam_*` szczegóły, `overhang_*` progi |
| Profile maszyny ignorowane | Pola z sekcji `machine_settings` (takie jak `bed_shape`, `max_print_height`, `printable_area`) nie są przekazywane do WASM |
| Brak walidacji | Nieprawidłowy plik JSON zgłasza ogólny błąd, bez wskazania konkretnego pola |

### Inne UI

| Problem | Szczegóły |
|---------|-----------|
| Brak wskaźnika postępu slicowania | Spinner bez informacji o etapie (perimeters / infill / gcode export) |
| Rozmiar pliku STL | Duże pliki STL (>50 MB) mogą powodować zacinanie się podczas podglądu |

---

## ❌ Nie zaimplementowane

### Formaty plików

| Funkcja | Priorytet |
|---------|-----------|
| 3MF import | 🔴 wysoki — standardowy format OrcaSlicera |
| OBJ import | 🟡 średni |
| STEP / IGES import | 🔴 nie możliwy w WASM — OCCT wyłączone |
| Multi-plik (wiele STL naraz) | 🟡 średni |

### Zaawansowane funkcje slicowania

| Funkcja | Priorytet |
|---------|-----------|
| Szacowanie czasu druku | 🔴 wysoki — wymaga odczytu komentarzy G-code lub osobnego API |
| Szacowanie zużycia filamentu | 🔴 wysoki — j.w. |
| Variable layer height | 🟡 średni |
| Modifier meshes | 🟠 niski |
| Support enforcement / blocking zones | 🟡 średni |
| Multi-material / multi-extruder | 🟠 niski (wymaga zmian w silniku) |
| Multi-object na jednym stole | 🟡 średni |
| Auto-arrange wielu obiektów | 🟡 średni |

### Podgląd G-code

| Funkcja | Priorytet |
|---------|-----------|
| Kolorowanie wg typu ruchu (perimeter / infill / support / travel) | 🔴 wysoki |
| Wyświetlanie travel moves | 🟡 średni |
| Statystyki (czas, filament, liczba warstw) | 🔴 wysoki |
| Suwak odtwarzania (czas, nie warstwa) | 🟠 niski |

### Integracje

| Funkcja | Priorytet |
|---------|-----------|
| Wysyłanie G-code przez OctoPrint REST API | 🟡 średni |
| Wysyłanie do drukarek Bambu Lab | 🟠 niski (protokół proprietarny) |
| PWA / tryb offline | 🟡 średni — Service Worker + cache WASM |
| Udostępnianie konfiguracji przez URL | 🟠 niski |

### WASM build

| Funkcja | Priorytet |
|---------|-----------|
| Skompilowany build OrcaSlicer v2.3.2 | 🔴 wysoki — infrastruktura gotowa w `orca-wasm/` |
| Wielowątkowość (SharedArrayBuffer + WASM threads) | 🟠 niski — wymaga COOP/COEP i znacznej pracy |

---

## 🗺️ Roadmap

```
v0.2  ── Własny build WASM v2.3.2
      ── Czas druku + zużycie filamentu z G-code
      ── Kolorowanie G-code wg typu ruchu
      ── 3MF import

v0.3  ── Konfigurowalny rozmiar stołu per drukarka
      ── PWA / Service Worker (tryb offline)
      ── Multi-object plate

v0.4  ── OctoPrint integration
      ── Variable layer height UI
```

---

## 🏗️ Architektura — status komponentów

```
src/
├── App.tsx                ✅ pełna logika UI, tabs, WASM orchestration
├── components/
│   ├── FileUpload.tsx     ✅ drag & drop, walidacja STL
│   ├── ModelViewer.tsx    ✅ Three.js, STLLoader, bed grid, OrbitControls
│   ├── GcodeViewer.tsx    ✅ toolpaths, layer slider — ⚠️ brak travel, statystyk
│   ├── SettingsPanel.tsx  ✅ presety, import profili — ⚠️ niekompletne mapowanie
│   └── SlicePanel.tsx     ✅ progress states, download G-code
├── lib/
│   ├── profiles.ts        ✅ presety, 30+ pól ORCA_FIELD_MAP — ⚠️ nie wszystkie pola
│   ├── wasm-loader.ts     ✅ orc_init / orc_slice / error codes
│   └── worker-singleton.ts ✅ singleton, base URL z Vite BASE_URL
├── workers/
│   └── slicer.worker.ts   ✅ WASM load + chunk reassembly + SLICE
└── types/index.ts         ✅ OrcaConfig, WorkerMessages, SliceStatus

orca-wasm/                 ⚠️ infrastruktura gotowa, NIE SKOMPILOWANO jeszcze
├── bridge/slicer.cpp      ✅ napisany, nie testowany (wymaga buildu)
├── wasm/shims/tbb/        ✅ kompletne stubs
└── patches/apply.py       ✅ patcher gotowy

public/wasm/               ⚠️ pliki z allanwrench v1.1, v2.3.2 pending
CLI (cli/)                 ✅ działa lokalnie
```
