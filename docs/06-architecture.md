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
│  │  thread) │   │  worker.ts)│   │  v2.3.1 core)│  │
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
| `slicer.js` | 1.2 MB | Emscripten glue code (IIFE) |
| `slicer.wasm` | 6.4 MB | Skompilowany OrcaSlicer core |
| `slicer.data` | 144 MB | Dane profili, materiałów, domyślne konfiguracje |

Źródło: [`allanwrench28/orcaslicer-wasm`](https://github.com/allanwrench28/orcaslicer-wasm) release v1.1.  
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

Problem: React StrictMode montuje komponenty dwukrotnie w dev → dwa workery → dwa pobrania 144 MB.

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
- Parsuje `G0`/`G1` z ekstruzją (parametr `E`)
- Grupuje segmenty po wartości Z
- Centruje współrzędne (odejmuje środek ciężkości X/Y aby wyrównać z ModelViewer)
- Warstwy kolorowane rotacyjnie (8 kolorów)
- Suwak warstw: wyświetla od pierwszej do wybranej warstwy

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
| UI | React 18, TypeScript 5, Tailwind CSS |
| 3D | Three.js 0.170 (STLLoader, OrbitControls) |
| Bundler | Vite 5 (worker ES format, COOP/COEP headers) |
| WASM | OrcaSlicer v2.3.1 via Emscripten (orcaslicer-wasm) |
| Worker | Web Worker (ES module, blob URL trick) |
| CLI | Commander, tsx, chalk, ora |

## Skalowanie i ograniczenia

- Plik `slicer.data` (144 MB) nie może być w repozytorium — za duży dla GitHub (limit 100 MB/plik)
- Pobieranie WASM przy pierwszym uruchomieniu: ~150 MB, jednorazowo (przeglądarka może cache'ować)
- Slicowanie blokuje worker thread ~50–500 ms w zależności od złożoności modelu
- Tylko format STL (binary i ASCII) — brak 3MF/OBJ/AMF
