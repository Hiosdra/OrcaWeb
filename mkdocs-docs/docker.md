# Self-hosting with Docker

OrcaWeb publishes a Docker image on every release (`docker-publish.yml`),
built from the [`Dockerfile`](https://github.com/Hiosdra/OrcaWeb/blob/master/Dockerfile)
at the repo root. It serves the app as a static site via nginx, with the
single-threaded (ST) WASM engine baked in — no external dependencies at
runtime.

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

## Tags

- `latest` — the most recently published release
- `<version>` / `v<version>` (e.g. `0.8.27` / `v0.8.27`) — a specific release
