# Krok 1 — Research

**Data:** 2026-06-09  
**Status:** Ukończony

---

## Cel

Zbadanie możliwości uruchomienia OrcaSlicera w przeglądarce (WebAssembly) i zaprojektowanie architektury dla aplikacji webowej inspirowanej Prusa EasyPrint, ale ze wsparciem profili OrcaSlicera.

---

## Znaleziska

### 1. orcaslicer-wasm

**Repozytorium:** https://github.com/allanwrench28/orcaslicer-wasm  
**Status:** Funkcjonalny prototyp (pre-release v1.1, październik 2025)

Kompiluje rdzeń OrcaSlicera v2.3.1 do WebAssembly za pomocą Emscripten. Całe przetwarzanie odbywa się po stronie klienta — żadne dane nie trafiają na serwer.

**Gotowe artefakty (release v1.1):**
| Plik | Rozmiar | Opis |
|------|---------|------|
| `slicer.js` | 1.2 MB | JavaScript bindings (CommonJS) |
| `slicer.wasm` | 6.4 MB | Skompilowany rdzeń OrcaSlicera |
| `slicer.data` | 144 MB | Zasoby (profile, fonty, tabele) |
| `schema.json` | 25 KB | Schemat 87 opcji konfiguracyjnych |

**Co działa:**
- Pełne generowanie G-code ze wszystkimi algorytmami slicingu
- Parametry druku: wysokość warstwy, prędkości, temperatury
- Kontrola jakości: loops ścian, warstwy top/bottom, pozycja szwu
- Wzory wypełnienia: grid, gyroid, honeycomb, triangles, cubic, lightning
- Generowanie supportów: standard, tree, hybrid
- Multi-material (wiele ekstruderów)
- Naprawa siatki STL
- Zarządzanie profilami (printer, filament, process)

**Co NIE działa:**
- Podgląd 3D (OpenGL wyłączony)
- Podgląd warstw G-code
- Formaty STEP/IGES (wymaga OpenCASCADE)
- Wielowątkowość (SharedArrayBuffer niekompletny)
- Text engraving (FreeType niedostępny)

### 2. WASM API

Eksportowane funkcje C:

```javascript
// Inicjalizacja z konfiguracją JSON
_orc_init(payloadPtr: number, payloadLength: number): number  // 0 = sukces

// Slicing STL -> G-code
_orc_slice(
  inputPtr: number,    // wskaźnik na dane STL
  inputLen: number,    // długość danych STL
  outputPtrPtr: number, // wskaźnik na wskaźnik wynikowego G-code
  outputLenPtr: number  // wskaźnik na długość wyniku
): number              // 0 = sukces, ujemne = błąd
```

Kody błędów:
- `-1` — nie udało się załadować STL (uszkodzona geometria)
- `-2` — brak obiektów do druku na płycie
- `-3` — błąd generowania G-code
- `-4` — wewnętrzny wyjątek OrcaSlicera

Zarządzanie pamięcią (ręczne):
```javascript
const ptr = module._malloc(size)
module.setValue(ptr + i, byte, 'i8')
module._free(ptr)
module.getValue(ptr, 'i32')  // odczyt wskaźnika
module.UTF8ToString(ptr, len) // konwersja G-code na string
```

### 3. Schemat konfiguracji (87 opcji)

Główne parametry z `schema.json`:

| Klucz | Typ | Domyślnie | Jednostka |
|-------|-----|-----------|-----------|
| `printer_model` | string | "Generic" | — |
| `nozzle_diameter` | float | 0.4 | mm |
| `filament_type` | string | "PLA" | — |
| `nozzle_temperature` | int | 210 | °C |
| `bed_temperature` | int | 60 | °C |
| `layer_height` | float | 0.2 | mm |
| `wall_loops` | int | 3 | — |
| `sparse_infill_density` | percent | 15% | % |
| `default_speed` | float | 100 | mm/s |
| `outer_wall_speed` | float | 60 | mm/s |
| `initial_layer_speed` | float | 30 | mm/s |
| `travel_speed` | float | 150 | mm/s |
| `enable_support` | bool | false | — |
| `support_type` | enum | "normal(auto)" | — |
| `brim_width` | float | 0 | mm |
| `seam_position` | enum | "aligned" | — |
| `top_shell_layers` | int | 4 | — |
| `fan_min_speed` | percent | 100% | % |

### 4. Natywny CLI OrcaSlicera

OrcaSlicer ma wbudowany tryb headless (używany przez WASM wrapper w podobny sposób):

```bash
orca-slicer --slice 0 \
  --load-settings machine.json;process.json \
  --load-filaments filament.json \
  --export-3mf output.gcode.3mf \
  model.3mf
```

Kody wyjścia: 0 (sukces), -1 do -7 (błędy konfiguracji), -50/-51 (walidacja), -100/-102 (slicing).

### 5. Prusa EasyPrint — analiza architektury

EasyPrint to **cloud-based** (serwer wykonuje slicing, nie WASM). Interfejs frontendowy wysyła plik do serwerów Prusa, otrzymuje G-code.

**Kluczowe cechy UX do zaadaptowania:**
- Wizard krokowy (upload → ustawienia → druk)
- Minimalistyczny, mobile-first design
- Automatyczne wykrywanie podłączonych drukarek
- Integracja z Printables (baza modeli)
- Wsparcie dla 22+ marek drukarek

**Nasza przewaga nad EasyPrint:**
- 100% prywatne (zero serwerów, zero uploadu)
- Działa offline
- Profile OrcaSlicera (szersze wsparcie drukarek)
- Open-source

---

## Decyzje architektoniczne

Podjęte na podstawie researchu:

| Decyzja | Wybór | Uzasadnienie |
|---------|-------|--------------|
| Architektura slicingu | WASM (klient) | Zero serwera, prywatność, offline |
| Źródło WASM | Pre-built z GitHub releases | Unika ~10 GB toolchain (Emscripten + Boost + CGAL) |
| Frontend stack | React 18 + Vite 5 + TypeScript 5 | Najlepszy DX, ecosystem |
| Stylowanie | Tailwind CSS | Szybki development, responsive |
| 3D podgląd | Three.js | Najlepsza biblioteka do STL w przeglądarce |
| CLI | Node.js + Commander + tsx | Prosty DX, bez build step |
| Profile | Własne presety + JSON override | Nie wymaga wszystkich plików profili OrcaSlicera |
