# 05 — Weryfikacja MVP

**Status:** ✅ Ukończony  
**Data:** 2026-06-09

## Cel

Zweryfikowanie, że pełny przepływ użytkownika działa end-to-end w przeglądarce:
upload STL → podgląd 3D → ustawienia → slicowanie → pobranie G-code.

## Wyniki weryfikacji

### Status modułu WASM
- `getWasmStatus()` zwraca `"ready"` po załadowaniu
- Ładowanie: slicer.js (1.2 MB) → slicer.wasm (6.4 MB) → slicer.data (144 MB) — wszystkie z HTTP 200

### Singleton worker
- `worker-singleton.ts` zapobiega podwójnemu tworzeniu workera przy HMR i React StrictMode
- `preloadWasm()` wywoływany w `main.tsx` przed renderem React — WASM zaczyna się ładować natychmiast
- `WasmStatusBadge` w nagłówku pokazuje "Loading engine…" podczas ładowania, znika gdy gotowy

### Pełny przepływ UI
1. **Upload** — drag & drop pliku `.stl` → Three.js STLLoader renderuje podgląd 3D
2. **Settings** — wybór drukarki (Generic 0.4, Bambu P1S, X1C, Ender 3, Prusa MK4, Voron 2.4), filamantu (PLA/PETG/ABS/TPU), jakości (Draft/Standard/Fine), wypełnienia, podpór
3. **Slice** — kliknięcie "Slice model" → `_orc_init` + `_orc_slice` w Web Worker → G-code zwrócony do głównego wątku
4. **Download** — zielony przycisk "Download G-code" → `Blob` → `<a>` click → zapis pliku

### Wyniki slicowania testowego
- Model: sześcian 10×10×10 mm (12 trójkątów, poprawne normalne, zamknięta geometria)
- Wynik: **4 329 linii · 88 KB G-code**
- Czas: ~150 ms (`orc_slice wall_time_ms ≈ 152`)

## Znane ograniczenia

- Plik `slicer.data` (144 MB) musi być w `public/wasm/` — nie jest w repozytorium (gitignore), pobierany przez `node scripts/download-wasm.mjs`
- WASM obsługuje tylko pliki STL (binary i ASCII powinny działać)
- Brak podglądu G-code w 3D (tylko tekst, pierwsze 50 linii)

## Architektura finalna

```
main.tsx
  └── preloadWasm()            ← start WASM loading before React
  └── <App />
        └── worker-singleton.ts   ← module-level singleton
              └── slicer.worker.ts  ← Web Worker
                    └── wasm-loader.ts  ← _orc_init / _orc_slice
                          └── public/wasm/slicer.js + .wasm + .data
```

## Spełnienie celu MVP

> "MVP działający w przeglądarce slicowanie plików STL orcaslicer" ✅

Slicowanie działa w pełni po stronie klienta — pliki użytkownika nigdy nie opuszczają urządzenia.
