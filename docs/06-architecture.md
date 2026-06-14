# 06 — Architektura OrcaWeb

**Status:** ✅ Ukończony  
**Data:** 2026-06-09

## Przegląd

OrcaWeb to przeglądarkowy slicer oparty na WebAssembly. Cały pipeline slicowania działa po stronie klienta — pliki użytkownika nigdy nie opuszczają urządzenia.

```
┌─────────────────────────────────────────────────────┐
│                   Przeglądarka                       │
│                                                      │
│  ┌──────────┐   ┌────────────┐   ┌──────────────┐  │
│  │ React UI │──▶│  Web Worker│──▶│ slicer.wasm  │  │
│  │ (main    │◀──│  (slicer.  │◀──│ (OrcaSlicer  │  │
│  │  thread) │   │  worker.ts)│   │  v2.3.2 core)│  │
│  └──────────┘   └────────────┘   └──────────────┘  │
│        │                                             │
│        ▼                                             │
│  ┌──────────┐   ┌────────────┐                      │
│  │Three.js  │   │Three.js    │                      │
│  │ModelView │   │GcodeViewer │                      │
│  └──────────┘   └────────────┘                      │
└─────────────────────────────────────────────────────┘
```

## Warstwa WASM

### Pliki artefaktów (`public/wasm/`)
| Plik | Rozmiar | Opis |
|------|---------|------|
| `slicer.js` | ~1.5 MB | Emscripten glue code (IIFE) |
| `slicer.wasm` | ~7.5 MB | Skompilowany OrcaSlicer v2.3.2 core |

Brak `slicer.data` — headless flat-config slicer nie czyta `orca/resources` w runtime;
plik danych został usunięty (200 MB → 0).

Źródło: OrcaWeb GitHub Release [`wasm-v2.3.2`](https://github.com/Hiosdra/OrcaWeb/releases/tag/wasm-v2.3.2) (własny build `orca-wasm/`).  
Pobieranie: `node scripts/download-wasm.mjs`

### API WASM
```typescript
// Inicjalizacja z konfiguracją JSON
_orc_init(configJsonPtr: number, len: number): number  // 0 = sukces

// Slicowanie
_orc_slice(stlPtr: number, stlLen: number, outPtrPtr: number, outLenPtr: number): number
// kody błędów: -1 nieprawidłowy STL, -2 brak obiektów, -3 błąd G-code, -4 wyjątek

// Zarządzanie pamięcią (ręczne — sterta Emscripten)
_malloc(size: number): number
_free(ptr: number): void
setValue(ptr, value, type)   // 'i32', 'i8', itd.
getValue(ptr, type): number
HEAPU8: Uint8Array           // widok na całą stertę WASM
UTF8ToString(ptr): string
```

### Ładowanie modułu (blob URL trick)
Emscripten generuje IIFE, nie ES module. Żeby zaimportować dynamicznie w Web Worker:
```typescript
// Pobierz slicer.js jako tekst
const jsText = await fetch('/wasm/slicer.js').then(r => r.text())
// Dołącz eksport default
const blob = new Blob([jsText + '\nexport default OrcaModule;'], { type: 'text/javascript' })
const blobUrl = URL.createObjectURL(blob)
// Importuj jako ES module
const { default: factory } = await import(blobUrl)
const module = await factory({ wasmBinary, locateFile: p => `/wasm/${p}` })
```

## Warstwa Web Worker

**`src/workers/slicer.worker.ts`** — izoluje WASM od głównego wątku (blokuje ~150ms podczas slicowania).

### Protokół wiadomości
```
Main → Worker:
  { type: 'LOAD_WASM', url: '/wasm/slicer.js' }
  { type: 'SLICE', stl: ArrayBuffer, config: OrcaConfig }

Worker → Main:
  { type: 'WASM_LOADED' }
  { type: 'WASM_ERROR', message: string }
  { type: 'SLICE_COMPLETE', gcode: string }
  { type: 'SLICE_ERROR', code: number, message: string }
```

### Kolejkowanie żądań
Jeśli `SLICE` nadejdzie przed zakończeniem `LOAD_WASM`, worker kolejkuje żądanie w `pendingSlice` i wykonuje je automatycznie po załadowaniu.

## Singleton Worker

**`src/lib/worker-singleton.ts`** — moduł-poziomowy singleton zapobiegający podwójnemu tworzeniu workera.

Problem: React StrictMode montuje komponenty dwukrotnie w dev → dwa workery → podwójne pobranie i inicjalizacja ~9 MB WASM.

Rozwiązanie: Worker jest tworzony raz per sesja przeglądarki, przechowywany w zmiennej modułu (`let worker: Worker | null = null`). `preloadWasm()` wywołany w `main.tsx` przed renderem React — WASM zaczyna się ładować zanim użytkownik cokolwiek kliknie.

## Warstwa React

```
App.tsx
├── worker-singleton (subscribe do zdarzeń)
├── FileUpload       — drag & drop STL
├── ModelViewer      — Three.js, model na stole drukarki
├── SettingsPanel    — presety + overrides + import profili
├── SlicePanel       — przycisk slice + download G-code
└── GcodeViewer      — Three.js, toolpaths warstwami
```

### Przepływ danych
```
File (drop) ──▶ file state ──▶ ModelViewer (Three.js STLLoader)
                     │
                     ▼
              config (buildConfig + overrides)
                     │
              handleSlice()
                     │
                     ├─ wasmStatus=ready ──▶ worker.postMessage(SLICE)
                     └─ wasmStatus=loading ──▶ pendingSliceRef (czeka na WASM_LOADED)
                                                      │
                                                Worker doSlice()
                                                      │
                                              SLICE_COMPLETE { gcode }
                                                      │
                                              sliceStatus = { phase: 'done', gcode }
                                                      │
                                         ┌────────────┴────────────┐
                                         ▼                         ▼
                                   ModelViewer              GcodeViewer
                                 (STL na stole)         (toolpaths warstwami)
```

## Wizualizacja 3D

### ModelViewer — układ współrzędnych
- Model wycentrowany na X/Z, dolna ściana przy Y=0 (na stole)
- Skala w mm (rzeczywista)
- Stół drukarki: 250×250 mm `PlaneGeometry`

### GcodeViewer — parser G-code
- Parsuje `G0`/`G1`; ruchy z ekstruzją (parametr `E`) → toolpaths; pozostałe → travel moves
- Odczytuje komentarze `;TYPE:` (OrcaSlicer) i koloruje każdy typ feature osobno (outer wall, inner wall, infill, support itd.)
- Gradient kolorów wg wysokości (niebieski → pomarańczowy) gdy GCode nie zawiera `;TYPE:`
- Grupuje segmenty po wartości Z; centruje X/Y względem środka ciężkości
- Renderuje linie przez `LineSegments2` + `LineSegmentsGeometry` + `LineMaterial` (grubość 1.6 px w screen-space) — `LineBasicMaterial` jest ignorowany przez WebGL poza linewidth=1
- Travel moves (G0 / G1 bez E) renderowane osobno jako szare, półprzezroczyste `LineSegments`; domyślnie ukryte, przełącznik „Travels" w pasku sterowania
- Layer cursor plane: półprzezroczysta płaszczyzna śledząca aktualną warstwę na suwaku
- Legenda typów feature (overlay prawy górny róg) gdy `;TYPE:` są obecne
- Suwak warstw: wyświetla od pierwszej do wybranej warstwy; `LineMaterial.resolution` aktualizowane przy resize

### Wyrównanie układów współrzędnych
```
G-code:      X/Y = płaszczyzna stołu, Z = wysokość
Three.js:    Y = góra (up)
Mapowanie:   gcodeX → three.X, gcodeY → three.Z, gcodeZ → three.Y
Centrowanie: odejmij centroid(gcodeX, gcodeY) aby model był przy origin
```

## Profile

**`src/lib/profiles.ts`** — trzy typy presetów:
- `PRESETS` — jakość wydruku (Draft/Standard/Fine)
- `FILAMENT_PRESETS` — materiały (PLA/PETG/ABS/TPU)
- `PRINTER_PRESETS` — drukarki (Generic, Bambu, Ender, Prusa, Voron)
- `parseOrcaProfileJson()` — import JSON z desktopowego OrcaSlicera

### Format profilu OrcaSlicer
```json
{
  "type": "process",
  "inherits": "fdm_process_common",
  "name": "0.20mm Standard @BBL X1C",
  "layer_height": "0.2",
  "wall_loops": "3",
  "sparse_infill_density": "15%"
}
```
Wartości numeryczne są zakodowane jako stringi — `parseOrcaProfileJson` konwertuje je automatycznie.

## Stack technologiczny

| Warstwa | Technologia |
|---------|-------------|
| UI | React 19, TypeScript 5, Tailwind CSS v4 |
| 3D | Three.js 0.170 (STLLoader, OrbitControls) |
| Bundler | Vite 5 (worker ES format, COOP/COEP headers) |
| WASM | OrcaSlicer v2.3.2 via Emscripten (własny build `orca-wasm/`) |
| Worker | Web Worker (ES module, blob URL trick) |
| CLI | Commander, tsx, chalk, ora |

## Skalowanie i ograniczenia

- Pobieranie WASM przy pierwszym uruchomieniu: ~9 MB jednorazowo (slicer.js + slicer.wasm z GitHub Releases); PWA Service Worker pre-cache'uje je automatycznie
- Slicowanie blokuje worker thread ~50–500 ms w zależności od złożoności modelu
- Tylko formaty STL (binary i ASCII), 3MF oraz STEP/IGES (konwertowane przez occt-import-js; ~8 MB dodatkowego WASM ładowane przy pierwszym użyciu) — brak OBJ/AMF
- Duże pliki STL (>50 MB) mogą powodować zacinanie podczas podglądu 3D
