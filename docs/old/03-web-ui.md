# Krok 3 — Web UI

**Data:** 2026-06-09  
**Status:** Ukończony (bez artefaktów WASM — wymagane pobranie)

---

## Cel

Zbudowanie przeglądarowej aplikacji webowej:
- Inspirowanej Prusa EasyPrint (prostota UX, mobile-first)
- Wsparcie profili OrcaSlicera
- Całkowicie client-side (WASM)
- 3D podgląd modelu STL
- Slicing w tle (Web Worker)

---

## Stack

| Technologia | Wersja | Rola |
|-------------|--------|------|
| React | 18.3 | UI framework |
| Vite | 5.4 | Build tool + dev server |
| TypeScript | 5.6 | Typowanie |
| Tailwind CSS | 3.4 | Stylowanie |
| Three.js | 0.170 | Podgląd 3D STL |
| Web Workers | native | Izolacja WASM od UI thread |

---

## Struktura plików

```
src/
├── main.tsx                    # Punkt wejścia React
├── App.tsx                     # Główny komponent — routing między zakładkami
├── index.css                   # Tailwind + globalne style
├── types/
│   └── index.ts                # Wszystkie interfejsy TypeScript
├── lib/
│   ├── wasm-loader.ts          # Ładowanie WASM + funkcja sliceStl()
│   └── profiles.ts             # Presety printer/filament/process
├── workers/
│   └── slicer.worker.ts        # Web Worker (LOAD_WASM + SLICE)
└── components/
    ├── FileUpload.tsx           # Drag & drop STL
    ├── ModelViewer.tsx          # Three.js 3D podgląd
    ├── SettingsPanel.tsx        # Panel ustawień
    └── SlicePanel.tsx           # Przycisk slice + wynik + download
```

---

## Architektura

### Web Worker — protokół wiadomości

```
Main thread                          Worker
    │                                   │
    │── LOAD_WASM { url } ─────────────>│
    │                         fetch WASM │
    │<── WASM_LOADED ─────────────────── │
    │                                   │
    │── SLICE { stl: ArrayBuffer,       │
    │           config: OrcaConfig } ──>│
    │                         orc_init  │
    │                         orc_slice │
    │<── SLICE_COMPLETE { gcode } ───── │
    │
    └── (lub WASM_ERROR / SLICE_ERROR)
```

Transfer `ArrayBuffer` (STL) przez `postMessage` z Transferable — zero kopii danych.

### Stan aplikacji

```typescript
type SliceStatus =
  | { phase: 'idle' }
  | { phase: 'loading-wasm' }
  | { phase: 'slicing' }
  | { phase: 'done'; gcode: string; filename: string }
  | { phase: 'error'; message: string }
```

### System profili

Trójpoziomowy merge konfiguracji:
```
PRINTER_PRESETS[printer]   ← bazowe parametry drukarki
  + FILAMENT_PRESETS[filament] ← temperatury, chłodzenie
    + PRESETS[preset].config   ← jakość, prędkości
      + configOverrides         ← ręczne zmiany użytkownika
```

---

## UI — przepływ użytkownika

### Zakładka 1: Model

```
┌─────────────────────────────────┐
│  ↑  Drop your STL file here     │
│     or click to browse          │
│     .stl format only            │
└─────────────────────────────────┘
        ↓ po załadowaniu
┌─────────────────────────────────┐
│  [Three.js 3D podgląd]          │
│  (OrbitControls — obracanie,    │
│   zoom, pan)                    │
└─────────────────────────────────┘
[ Continue to settings → ]
```

### Zakładka 2: Settings

```
┌──────────────┬──────────────────┐
│ [3D Preview] │ PRINTER          │
│              │   Select: ▼      │
│              │                  │
│              │ FILAMENT         │
│              │   Material: ▼    │
│              │   Nozzle: [220]°C│
│              │   Bed:    [ 60]°C│
│              │                  │
│              │ QUALITY          │
│              │ [Draft][Std][Fine]│
│              │   Layer: [0.2]mm │
│              │   Walls: [ 3 ]   │
│              │                  │
│              │ INFILL           │
│              │   ══════░ 15%    │
│              │   Pattern: ▼     │
│              │                  │
│              │ SUPPORTS         │
│              │   Enable  ○──●   │
│              │                  │
│              │ ▼ Advanced       │
└──────────────┴──────────────────┘
[ Ready to slice → ]
```

### Zakładka 3: Slice

```
┌────────────────────────────┐
│  Slice summary             │
│  ─────────────────────     │
│  File      model.stl       │
│  Printer   BambuLab P1S    │
│  Material  PLA             │
│  Layers    0.2mm           │
│  Infill    15% grid        │
│  Nozzle    220°C           │
│  Supports  none            │
└────────────────────────────┘

┌────────────────────────────┐
│  ⚡ Slice model            │  ← niebieski przycisk
└────────────────────────────┘

  ↓ po kliknięciu:

  [spinner] Loading slicer engine…
  [spinner] Slicing…

  ↓ po zakończeniu:

┌────────────────────────────┐
│  ✓ Slicing complete!       │
│  45,231 lines · 892 KB     │
│  [↓ Download G-code]       │
│                            │
│  ▶ Preview G-code          │
│  ; HEADER                  │
│  ; layer_height = 0.2      │
│  G28 ; home all            │
│  ...                       │
└────────────────────────────┘
```

---

## Komponenty

### FileUpload

- Drag & drop z wizualnym feedback (border zmienia kolor, lekkie skalowanie)
- Klik → `<input type="file" accept=".stl">`
- Wyświetla nazwę + rozmiar po załadowaniu
- `onFile(file: File)` callback

### ModelViewer

Podgląd 3D oparty na Three.js:
- `STLLoader` — parsuje STL (binary + ASCII)
- `OrbitControls` — obracanie myszą/dotykiem
- Auto-skalowanie modelu do 100 jednostek
- `ResizeObserver` — responsywny canvas
- `MeshPhongMaterial` w kolorze orca-blue z cieniem kierunkowym
- `GridHelper` — wizualizacja stołu druku
- Cleanup na unmount (dispose renderer, geometry, material)

### SettingsPanel

- `Section` — sekcja z nagłówkiem
- `SelectField` — `<select>` z etykietą
- `NumberField` — `<input type="number">` z min/max/step
- `ToggleField` — przełącznik boolean (custom CSS toggle)
- Zaawansowane ustawienia ukryte pod `<details>` expanderem
- Prędkości: default, outer wall, first layer, travel
- Seam position, ironing

### SlicePanel

- Przycisk slice: trzy stany (idle, loading, done)
- `Spinner` SVG animowany podczas ładowania
- Po sukcesie: zielona karta z linkami pobierania i podglądem G-code
- Po błędzie: czerwona karta z kodem i opisem błędu
- `downloadGcode()` — tworzy Blob, link `<a>`, click, revoke URL
- `GcodePreview` — pierwsze 50 linii w bloku `<pre>` z podświetlaniem

---

## Konfiguracja Vite

```typescript
// vite.config.ts
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  }
}
```

Nagłówki COOP/COEP wymagane dla `SharedArrayBuffer` (przyszłe wsparcie wielowątkowości WASM).

---

## Uruchomienie

```bash
# 1. Pobierz artefakty WASM (jednorazowo, ~152 MB)
node scripts/download-wasm.mjs

# 2. Uruchom dev server
npm run dev
# → http://localhost:5173
```

---

## TypeScript — główne typy

```typescript
interface OrcaConfig {
  printer_model?: string
  nozzle_diameter?: number
  filament_type?: string
  nozzle_temperature?: number
  bed_temperature?: number
  layer_height?: number
  wall_loops?: number
  sparse_infill_density?: number
  sparse_infill_pattern?: InfillPattern
  default_speed?: number
  outer_wall_speed?: number
  enable_support?: boolean
  support_type?: SupportType
  brim_width?: number
  seam_position?: SeamPosition
  // ...
}

type WorkerInMessage =
  | { type: 'LOAD_WASM'; url: string }
  | { type: 'SLICE'; stl: ArrayBuffer; config: OrcaConfig }

type WorkerOutMessage =
  | { type: 'WORKER_READY' }
  | { type: 'WASM_LOADED' }
  | { type: 'WASM_ERROR'; message: string }
  | { type: 'SLICE_COMPLETE'; gcode: string }
  | { type: 'SLICE_ERROR'; code: number; message: string }
```

---

## Znane ograniczenia / TODO

- [ ] Worker czeka 500ms po LOAD_WASM zamiast reagować na event WASM_LOADED — do poprawki
- [ ] Brak podglądu warstw G-code (wymaga parsera G-code + Three.js LineSegments)
- [ ] Brak importu profilu JSON z pliku w UI (jest w CLI)
- [ ] `slicer.data` (144 MB) ładuje się przez HTTP przy starcie — przydałby się Service Worker cache
- [ ] Brak estymacji czasu druku przed slicingiem
- [ ] Brak wsparcia wielu plików STL (multi-object plate)
