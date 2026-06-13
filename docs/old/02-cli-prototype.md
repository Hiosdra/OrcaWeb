# Krok 2 — CLI Prototype

**Data:** 2026-06-09  
**Status:** Ukończony

---

## Cel

Zbudowanie CLI (Command Line Interface) w Node.js, które:
1. Ładuje moduł WASM OrcaSlicera
2. Przyjmuje plik STL jako wejście
3. Konfiguruje parametry druku przez flagi CLI lub pliki profili JSON
4. Zwraca G-code jako plik wyjściowy

---

## Struktura plików

```
cli/
├── package.json          # Zależności: commander, chalk, ora
├── tsconfig.json         # TypeScript (NodeNext modules, noEmit)
└── src/
    ├── index.ts          # Punkt wejścia — definicja komend (Commander)
    ├── slicer.ts         # Wrapper WASM (Node.js-specific I/O)
    └── download.ts       # Auto-download artefaktów WASM
```

---

## Komendy

### `orca-cli setup`
Pobiera artefakty WASM (~152 MB) z GitHub releases. Wymagane przed pierwszym użyciem.

```
orca-cli setup
```

Wyświetla postęp pobierania każdego pliku z procentowym wskaźnikiem.

---

### `orca-cli slice <file>`
Główna komenda — slicuje plik STL i zapisuje G-code.

```bash
# Podstawowe użycie
npx tsx cli/src/index.ts slice model.stl

# Z opcjami
npx tsx cli/src/index.ts slice model.stl \
  --preset fine \
  --printer "BambuLab P1S" \
  --filament PETG \
  --nozzle-temp 240 \
  --bed-temp 85 \
  --infill 25 \
  --supports \
  --brim 5 \
  --output output.gcode

# Z zewnętrznym profilem JSON (z OrcaSlicera)
npx tsx cli/src/index.ts slice model.stl \
  --profile ~/AppData/Roaming/OrcaSlicer/user/default/process/my_profile.json
```

**Pełna lista flag:**

| Flaga | Domyślnie | Opis |
|-------|-----------|------|
| `--preset` | `standard` | Preset jakości: `draft` / `standard` / `fine` |
| `--printer` | `Generic` | Model drukarki |
| `--filament` | `PLA` | Typ filamentu |
| `--layer-height` | `0.2` | Wysokość warstwy [mm] |
| `--infill` | `15` | Wypełnienie [%] |
| `--walls` | `3` | Liczba loops ścian |
| `--nozzle-temp` | `220` | Temperatura dyszy [°C] |
| `--bed-temp` | `60` | Temperatura stołu [°C] |
| `--supports` | off | Włącz supporty |
| `--brim` | `0` | Szerokość brim [mm] |
| `--speed` | `100` | Prędkość bazowa [mm/s] |
| `--nozzle` | `0.4` | Średnica dyszy [mm] |
| `--profile` | — | Ścieżka do pliku JSON z profilem |
| `-o, --output` | `<input>.gcode` | Ścieżka wyjściowa |

**Priorytet ustawień:** preset → flagi CLI → --profile (nadpisuje)

**Przykładowe wyjście:**
```
  OrcaWeb CLI v0.1.0

  Input:    benchy.stl (1.2 MB)
  Output:   benchy.gcode
  Preset:   standard
  Printer:  Generic / 0.4mm nozzle
  Filament: PLA @ 220°C / 60°C bed
  Layers:   0.2mm · 3 walls · 15% infill

  ✓ WASM artifacts ready
  ✓ Slicer engine ready
  ✓ Sliced in 8.3s

  ✓ benchy.gcode
  G-code lines: 45,231
  File size:    892 KB
  Est. print time: 1h 24m
```

---

### `orca-cli profiles`
Wyświetla listę wbudowanych presetów.

```
  Quality presets

  draft        0.3mm layers · 2 walls · 10% infill · 150 mm/s
  standard     0.2mm layers · 3 walls · 15% infill · 100 mm/s
  fine         0.1mm layers · 4 walls · 20% infill · 60 mm/s

  Filament types

  PLA          220°C nozzle · 60°C bed
  PETG         240°C nozzle · 80°C bed
  ABS          255°C nozzle · 100°C bed
  TPU          230°C nozzle · 50°C bed

  Printer presets

  Generic              Any FDM printer · 0.4mm nozzle · 100 mm/s
  BambuLab P1S         0.4mm · 300 mm/s default
  BambuLab X1C         0.4mm · 350 mm/s default
  Creality Ender-3     0.4mm · 60 mm/s default
  Prusa MK4            0.4mm · 120 mm/s default
  Voron 2.4            0.4mm · 200 mm/s default
```

---

## Implementacja WASM w Node.js

### Ładowanie modułu (`slicer.ts`)

WASM module (`slicer.js`) jest formatem CommonJS, ładowany przez `createRequire`:

```typescript
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const factory = require(jsPath)
const module = await factory({
  wasmBinary,
  locateFile: (name) => join(WASM_DIR, name),
})
```

### Przepływ slicingu

```
1. Deserializacja JSON config  →  bufor UTF-8
2. _malloc(configLen)           →  zapis do heap WASM
3. _orc_init(configPtr, len)    →  inicjalizacja silnika
4. _free(configPtr)
5. readFileSync(stlPath)        →  dane STL
6. _malloc(stlLen)              →  zapis STL do heap
7. _malloc(4) × 2               →  outPtrPtr + outLenPtr
8. _orc_slice(...)              →  slicing
9. getValue(outPtrPtr, 'i32')   →  adres G-code w heap
10. UTF8ToString(gcodePtr, len) →  string G-code
11. _free(×4)                   →  zwolnienie pamięci
12. writeFileSync(output)       →  zapis pliku
```

### Auto-download artefaktów (`download.ts`)

Sprawdza obecność i rozmiar plików przed pobraniem:
```typescript
if (existsSync(dest) && statSync(dest).size > approxSize * 0.9) {
  continue // Already present
}
```

Pobiera strumieniowo z GitHub releases z raportowaniem progresu przez callback.

---

## Zależności CLI

```json
{
  "commander": "^12.1.0",  // parsowanie argumentów
  "chalk": "^5.3.0",       // kolorowe wyjście
  "ora": "^8.1.0"          // spinner animacji
}
```

Uruchomienie bez build step (tsx):
```bash
npx tsx cli/src/index.ts <command>
```

---

## Testy

```bash
# Weryfikacja TypeScript
cd cli && npx tsc --noEmit  # 0 błędów

# Test komend
npx tsx cli/src/index.ts --help
npx tsx cli/src/index.ts profiles
npx tsx cli/src/index.ts slice --help
```

Wszystkie testy zakończone powodzeniem.

---

## Znane ograniczenia

- Wymaga Node.js ≥ 18 (używa native `fetch`)
- `slicer.data` (144 MB) ładuje się do pamięci przy starcie — pierwsze uruchomienie wolniejsze
- Brak obsługi formatów 3MF jako wejścia (tylko STL)
- Brak podglądu G-code w terminalu
