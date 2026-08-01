# Migrating a client frontend to the current WASM engine

This guide is for a client frontend that still downloads the original
`wasm-v2.4.2` release without a `-patchN` suffix.

The version distinction matters:

- **OrcaSlicer version:** still `v2.4.2`.
- **OrcaWeb WASM build:** the current single-threaded build is
  `wasm-v2.4.2-patch12`.
- **Optional multithreaded build:** `wasm-v2.4.2-patch13-multithreaded`.

The patch suffix is an immutable OrcaWeb build revision. It is not a new
upstream OrcaSlicer version, and the `-patchN` counter is independent from the
`-multithreaded` release family. This page was checked on **2026-08-01**.

## Target release matrix

| Use case | Release tag | Files | Runtime requirements |
|---|---|---|---|
| Default browser deployment | [`wasm-v2.4.2-patch12`](https://github.com/Hiosdra/OrcaWeb/releases/tag/wasm-v2.4.2-patch12) | `slicer.js`, `slicer.wasm` | Works on ordinary static hosting; no `SharedArrayBuffer` required |
| Cross-origin-isolated deployment | [`wasm-v2.4.2-patch13-multithreaded`](https://github.com/Hiosdra/OrcaWeb/releases/tag/wasm-v2.4.2-patch13-multithreaded) | `slicer-mt.js`, `slicer-mt.wasm` | `crossOriginIsolated === true`, COOP/COEP headers, and `SharedArrayBuffer` |

Use the ST release unless the frontend and its host already support the MT
requirements. Never combine the JavaScript glue from one release with the
`.wasm` file from another release.

## 1. Pin and download a matching artifact pair

Prefer downloading the files during the frontend build and serving them from
the same origin as the app. Do not make the browser resolve a GitHub `latest`
URL at runtime: release assets are immutable, and a floating URL makes cache
and rollback behaviour difficult to reason about.

For the default ST engine:

```bash
ENGINE_TAG="wasm-v2.4.2-patch12"
ENGINE_BASE="https://github.com/Hiosdra/OrcaWeb/releases/download/${ENGINE_TAG}"

mkdir -p public/wasm
curl --fail --location "${ENGINE_BASE}/slicer.js" \
  --output public/wasm/slicer.js
curl --fail --location "${ENGINE_BASE}/slicer.wasm" \
  --output public/wasm/slicer.wasm
```

Current headless builds do **not** publish `slicer.data`; do not carry over an
old `slicer.data` download from a previous frontend integration.

Verify the exact files before committing or publishing them:

```bash
printf '%s  %s\n' \
  '800a7dda56254f426cc84b48fb9a818daf2ea84b20d04e01bf2ced37e7f65bb2' \
  public/wasm/slicer.js \
  '8d481d1b1f7050b8acac2e28f812ca3fb0d130bf0720d2dc13d4934420ab88e7' \
  public/wasm/slicer.wasm | sha256sum --check
```

If MT is also shipped, download its pair from its own release tag:

```bash
MT_TAG="wasm-v2.4.2-patch13-multithreaded"
MT_BASE="https://github.com/Hiosdra/OrcaWeb/releases/download/${MT_TAG}"

curl --fail --location "${MT_BASE}/slicer-mt.js" \
  --output public/wasm/slicer-mt.js
curl --fail --location "${MT_BASE}/slicer-mt.wasm" \
  --output public/wasm/slicer-mt.wasm
```

The release assets are the authoritative source for the current digests and
sizes. Refresh this page's target tags and hashes when selecting a later
release.

## 2. Update the loader and cache key

The loader should use a fixed base directory and the two matching filenames:

```typescript
const engineBase = `${import.meta.env.BASE_URL}wasm`
const engineLabel = 'v2.4.2-patch12'
// For an ST-only deployment, use the first 16 hex characters of the ST
// slicer.wasm SHA-256 digest.
const engineBuild = '8d481d1b1f7050b8'

const engineUrl = (file: string) => `${engineBase}/${file}?v=${engineBuild}`

// ST
const jsUrl = engineUrl('slicer.js')
const wasmUrl = engineUrl('slicer.wasm')
```

The query parameter is intentional. The filenames are stable, so a
service-worker `CacheFirst` entry keyed only by `/wasm/slicer.wasm` can keep
serving the old base release forever. The key can be the first 16 hexadecimal
characters of the SHA-256 digest, as above, or another value that changes for
every binary build.

If the frontend has a service worker, update its cache strategy at the same
time:

1. Cache the new `?v=` URLs.
2. Remove the old fixed-URL entries during activation, or let the changed URL
   create a new cache entry and explicitly delete the old cache on the next
   release.
3. Test once with an existing installation, not only in a clean browser
   profile.

`engine-version.json` is optional for an independent client. For an ST-only
deployment, if the loader uses the same runtime manifest convention as OrcaWeb,
publish it beside the files:

```json
{
  "label": "v2.4.2-patch12",
  "version": "8d481d1b1f7050b8"
}
```

The manifest must not be cached longer than the engine deployment decision;
the engine files themselves may remain immutable and long-lived in cache.

If both ST and MT are published, derive the cache key from both deployed WASM
files, so a change to either variant produces a new URL:

```bash
cat public/wasm/slicer.wasm public/wasm/slicer-mt.wasm \
  | sha256sum | cut -c1-16
```

This is the convention used by OrcaWeb's production deploy. Do not reuse the
ST-only example above as the combined ST+MT manifest value.

## 3. Keep the browser loading contract

The release contains Emscripten glue (`slicer.js`) as a CommonJS-style IIFE,
not a browser-native ES module. A browser frontend must therefore either:

- use the existing worker loader pattern from the
  [Integration Guide](integration.md#loading-slicerjs-without-a-bundler), or
- load the glue as text, append an ES-module export in a Blob URL, and give the
  factory the matching `.wasm` location.

Do not import `slicer.js` directly through Vite and assume that its relative
`.wasm` lookup will work after bundling. Keep the engine in a Web Worker (or a
Node worker thread); slicing is synchronous inside the WASM call and blocks
the calling worker.

For a same-origin deployment, check that the server returns:

| File | Required response |
|---|---|
| `slicer.js` | `200`, JavaScript content type |
| `slicer.wasm` | `200`, `Content-Type: application/wasm` |

An SPA fallback that returns `index.html` with status `200` is still an engine
load failure. Check the response body and content type, not just `response.ok`.

## 4. Verify the bridge contract before changing application code

The current ST and MT artifacts expose the same C bridge. A patch release does
not require an application-level API rewrite. The important calls are:

| Operation | Export |
|---|---|
| Create and destroy state | `_orc_session_create`, `_orc_session_destroy` |
| Initialise a session | `_orc_init` |
| Slice one STL | `_orc_slice` |
| Arrange and slice multiple STLs | `_orc_slice_multi` |
| Convert OBJ or STEP to STL | `_orc_obj_to_stl`, `_orc_cad_to_stl` |
| Read or write mesh/config 3MF | `_orc_read_3mf`, `_orc_write_3mf` |
| Read errors and release bridge buffers | `_orc_decode_exception`, `_orc_free` |

If the old client wrapper predates the session-based bridge, migrate these
rules while changing the artifact pin:

1. Create one non-zero session after the module loads and reuse it for
   `_orc_init`, `_orc_slice`, `_orc_slice_multi`, and `_orc_write_3mf`.
2. Pass the session as the first argument to those calls.
3. Free bridge-returned buffers with `_orc_free`; destroy the session with
   `_orc_session_destroy`, not `_free`.
4. Keep OBJ/STEP conversion and 3MF-read error decoding sessionless where the
   [API Reference](api-reference.md) specifies a `0` session.

The optional current bridge keys for adaptive layer height are:

```json
{
  "adaptive_layer_height": true,
  "adaptive_layer_height_quality": 0.5
}
```

They are bridge pseudo-keys, not upstream OrcaSlicer options. Existing clients
can omit them and retain the previous fixed-layer-height behaviour.

## 5. Add MT only behind a runtime capability check

MT is not a drop-in replacement for ST. The page must send these headers on
the document and worker responses:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Select MT only when all of the following are true:

```typescript
const canUseMt =
  typeof SharedArrayBuffer !== 'undefined' &&
  globalThis.crossOriginIsolated === true
```

Also probe that `slicer-mt.js` really exists and is JavaScript. A missing asset
served as an HTML SPA fallback must select ST, not be passed to the ESM
loader. If MT is unavailable, fall back to `slicer.js`/`slicer.wasm` without
showing an engine error.

Do not fetch the MT files directly from GitHub Releases from a COEP-isolated
page. The release download redirects do not provide the CORS/CORP response
needed by that page. Mirror the files onto a host you control, serve them with
the required CORS policy, and keep the pthread worker script same-origin or
use the Blob URL approach from the existing loader. See
[ADR-011](adr/adr-011-multithreaded-engine.md).

## 6. Run the migration smoke test

Before switching production traffic, verify both a cold browser and an
existing service-worker installation:

- the network panel shows the pinned release's `slicer.js` and `slicer.wasm`,
  not `wasm-v2.4.2` without a suffix;
- both files return `200` and the expected content types, with no HTML body;
- the worker reaches `WASM_LOADED` and the UI reports the new engine label;
- `_orc_session_create()` returns a handle, `_orc_init()` returns `0`, and a
  small STL produces non-empty G-code;
- every output pointer returned by the bridge is released with `_orc_free()`;
- OBJ, STEP, 3MF, multi-file, and cancellation paths are tested if the client
  exposes them;
- an existing installed PWA updates its engine after the cache-key change;
- MT completes one slice on an isolated host and falls back to ST on a normal
  host;
- a representative old input still produces valid G-code. Compare toolpath
  structure and printer-relevant output, not raw byte equality, because engine
  builds can change ordering or metadata without an integration regression.

For this repository, the relevant local checks are:

```bash
npm run setup
npm run test
npm run build
npm run test:e2e
```

## Rollback

Rollback is a pin change, not a release mutation. Restore the previous
known-good release asset pair (the original migration target is
`wasm-v2.4.2`), restore its cache key, and invalidate the new service-worker
cache entry. Keep both releases available so the rollback can be reproduced
and audited.

For the complete bridge examples, see the [Integration Guide](integration.md)
and [API Reference](api-reference.md). For upstream release context, see the
[OrcaSlicer v2.4.2 release](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.4.2).
