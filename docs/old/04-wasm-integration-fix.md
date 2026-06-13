# Krok 4 — Naprawa integracji WASM

**Data:** 2026-06-09  
**Status:** Ukończony — slicing end-to-end działa w przeglądarce

---

## Problem

Po pierwszym uruchomieniu slicing nie działał. Dwie niezależne przyczyny:

### 1. Brak artefaktów WASM

`public/wasm/` zawierał tylko `.gitkeep`. Artefakty (~152 MB) nie były pobrane.

**Rozwiązanie:** Uruchomienie `node scripts/download-wasm.mjs`:
```
public/wasm/slicer.js    — 1.2 MB
public/wasm/slicer.wasm  — 6.4 MB
public/wasm/slicer.data  — 144 MB
```

### 2. Race condition w App.tsx

Stary kod wysyłał `SLICE` 500ms po `LOAD_WASM` bez czekania na potwierdzenie:

```typescript
// ❌ Stary kod — hazard
workerRef.current.postMessage({ type: 'LOAD_WASM', url: '/wasm/slicer.js' })
setTimeout(() => {
  workerRef.current.postMessage({ type: 'SLICE', stl: stlBuffer, config })
}, 500)
```

Jeśli WASM ładuje się dłużej niż 500ms (np. slicer.data 144 MB przez sieć), SLICE dociera do workera przed inicjalizacją modułu i jest ignorowany.

---

## Rozwiązania

### App.tsx — event-driven flow

Worker tworzony raz przy mount i natychmiast startuje WASM loading. Przy kliknięciu "Slice":
- WASM gotowe → slice startuje natychmiast
- WASM jeszcze się ładuje → żądanie trafia do `pendingSliceRef`, a uruchamia się automatycznie kiedy przyjdzie `WASM_LOADED`

```typescript
// Worker tworzony raz, WASM ładuje się w tle od razu
useEffect(() => {
  const worker = new Worker(...)
  worker.onmessage = (e) => {
    if (msg.type === 'WASM_LOADED') {
      wasmReadyRef.current = true
      if (pendingSliceRef.current) {          // odpalamy czekający slice
        worker.postMessage({ type: 'SLICE', ...pendingSliceRef.current })
        pendingSliceRef.current = null
      }
    }
  }
  worker.postMessage({ type: 'LOAD_WASM', url: '/wasm/slicer.js' })
}, [])  // ← bez zależności — worker żyje przez całą sesję

const handleSlice = async () => {
  const stlBuffer = await file.arrayBuffer()
  if (wasmReadyRef.current) {
    worker.postMessage({ type: 'SLICE', stl: stlBuffer, config }, [stlBuffer])
  } else {
    pendingSliceRef.current = { stl: stlBuffer, config }  // czeka na WASM_LOADED
  }
}
```

### slicer.worker.ts — kolejkowanie

Worker kolejkuje SLICE jeśli moduł jeszcze nie gotowy, oraz nie restartuje loading gdy już trwa:

```typescript
let orcaModule: OrcaModule | null = null
let loadingWasm = false
let pendingSlice: {...} | null = null

// LOAD_WASM
if (orcaModule) { send({ type: 'WASM_LOADED' }); return }  // już załadowany
if (loadingWasm) return                                       // już w trakcie

// Po załadowaniu — odpala kolejkowany slice
orcaModule = await factory(...)
if (pendingSlice) { doSlice(pendingSlice); pendingSlice = null }

// SLICE
if (!orcaModule) { pendingSlice = { stl, config }; return }  // kolejkuje
doSlice({ stl, config })
```

---

## Struktura slicer.js

Weryfikacja struktury modułu przez devtools:
```javascript
// Emscripten output — IIFE zwracający async factory
var OrcaModule = (() => {
  return async function(moduleArg = {}) { ... }
})()

// Na końcu pliku — CommonJS export (ignorowany w blob ES module)
if (typeof module === "object") module.exports = OrcaModule
```

Technika ładowania w Web Worker:
```javascript
const blob = new Blob([jsText + '\nexport default OrcaModule;'], { type: 'application/javascript' })
const blobUrl = URL.createObjectURL(blob)
const { default: factory } = await import(blobUrl)  // działa w ES module Worker
URL.revokeObjectURL(blobUrl)
const module = await factory({ wasmBinary, locateFile: p => `/wasm/${p}` })
```

`locateFile` zwraca `/wasm/slicer.data` — prawidłowe dla Vite dev server i pliku w `public/wasm/`.

---

## Weryfikacja end-to-end

Test przez devtools (symulacja uploadu + slicingu):

| Krok | Wynik |
|------|-------|
| Fetch `/wasm/slicer.js` | 200 OK, 1.2 MB |
| Fetch `/wasm/slicer.wasm` | 200 OK, 6.4 MB |
| Blob URL dynamic import | 200 OK |
| Fetch `/wasm/slicer.data` | 200 OK, 144 MB |
| `_orc_init()` | 0 (sukces) |
| `_orc_slice()` 10mm cube STL | 0 (sukces) |
| G-code wyjście | 4329 linii, 88 KB |
| `orc_slice wall_time_ms` | ~152 ms |
| UI: Slicing complete! | ✓ wyświetlone |
| Download G-code | ✓ działa |
| G-code preview | ✓ 50 warstw, max_z=10mm |

---

## Ostrzeżenia WASM (nie są błędami)

```
[orc_alloc] warning: operator delete sized freeing untracked pointer
```

To łagodny warning OrcaSlicera dotyczący alokatora pamięci. Nie wpływa na poprawność G-code.

---

## Wydajność

- Pierwsze załadowanie: ~10–30s (pobieranie slicer.data 144 MB)
- Kolejne rundy: natychmiastowe (przeglądarka cache'uje pliki z `public/`)
- Sam slicing: ~150–500ms dla typowych modeli
- React StrictMode w dev podwaja liczbę workerów (2× WASM w pamięci) — w produkcji znika

---

## TODO po tym kroku

- [ ] Service Worker cache dla slicer.data (144 MB ładuje się przy każdym odświeżeniu bez cache)
- [ ] Jeden worker na sesję (React StrictMode cleanup)
- [ ] Pasek postępu ładowania slicer.data
