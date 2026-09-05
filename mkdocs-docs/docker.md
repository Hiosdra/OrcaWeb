# Self-hosting with Docker

OrcaWeb publishes a Docker image on every release (`docker-publish.yml`),
built from the [`Dockerfile`](https://github.com/Hiosdra/OrcaWeb/blob/master/Dockerfile)
at the repo root. It serves the app as a static site via nginx, with both the
single-threaded (ST) and multithreaded (MT) WASM engines baked in — no
external dependencies at runtime.

## docker run

```bash
docker run --rm -p 8080:8080 ghcr.io/hiosdra/orcaweb:latest
```

Open <http://localhost:8080>.

## docker compose

```yaml
services:
  orcaweb:
    image: ghcr.io/hiosdra/orcaweb:latest
    ports:
      - "8080:8080"
    restart: unless-stopped
```

```bash
docker compose up -d
```

## Single-threaded vs multithreaded

The image bundles both engines side by side and lets the app pick at
runtime — same probe the GitHub Pages / Cloudflare deployments use (see
[ADR-011](adr/adr-011-multithreaded-engine.md)): the multithreaded (MT)
engine loads by default whenever the browser reports
`crossOriginIsolated` (nginx already sends the required
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers), with
automatic fallback to the single-threaded (ST) engine otherwise.

To force ST manually — e.g. to compare behavior, or to work around an
environment where MT misbehaves — open the app at `/st` instead of `/`:

```
http://localhost:8080/st
```

It's the same app (client-side routed), just with the MT engine probe
skipped. One symptom ST can hit that MT doesn't: STEP file conversion
failing with `boost::thread_resource_error: Resource temporarily
unavailable` — OCCT's STEP importer needs real thread support, which the ST
build only stubs out. If you see that error, use the default `/` (MT) path
rather than `/st`.

## Tags

- `latest` — the most recently published release
- `<version>` / `v<version>` (e.g. `0.8.27` / `v0.8.27`) — a specific release
