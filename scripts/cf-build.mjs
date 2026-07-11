#!/usr/bin/env node
/**
 * Vite build wrapper for Cloudflare Workers (static assets) deploys.
 *
 * Cloudflare cannot host the engine binary itself: slicer.wasm is ~36 MB and
 * Workers/Pages static assets are capped at 25 MiB per file. GitHub Pages —
 * the primary deployment, refreshed by deploy.yml on every master push —
 * already serves the exact engine bytes with `Access-Control-Allow-Origin: *`
 * and `Content-Type: application/wasm` (verified live; compileStreaming
 * works). So the Cloudflare build points VITE_WASM_BASE_URL at the GitHub
 * Pages copy instead of bundling the engine, and ships only the app shell.
 *
 * The cache-busting key (VITE_WASM_VERSION) and header label
 * (VITE_ORCA_VERSION) come from the engine-version.json manifest that
 * deploy.yml publishes next to the wasm files on gh-pages — it carries the
 * same sha-based key and resolved label as the GitHub Pages deploy itself,
 * describing the exact bytes being served (not package.json, whose version
 * doesn't change when an engine-only fix ships — the staleness bug the ?v=
 * key exists to prevent; see vite.config.ts). Fallbacks, in order: the
 * GitHub Releases API (works but rate-limited from Cloudflare's shared
 * build egress IPs — the first live CF build hit exactly that), then the
 * app version. Resolution is best-effort and never fails the deploy.
 *
 * Run via `npm run build:cf` — this is what the Cloudflare Workers Builds
 * "build command" must be set to (see mkdocs-docs/architecture.md).
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { ORCA_VERSION, REPO, resolveLatestWasmTag } from './lib/wasm-release.mjs'

const [owner, repo] = REPO.split('/')
const WASM_BASE_URL = `https://${owner.toLowerCase()}.github.io/${repo}/app/wasm`

const { version: appVersion = '0.0.0' } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
)

let wasmVersion = appVersion
let engineLabel = `${ORCA_VERSION} (via GitHub Pages, unresolved)`
try {
  const res = await fetch(`${WASM_BASE_URL}/engine-version.json`)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching engine-version.json`)
  const manifest = await res.json()
  if (typeof manifest.version !== 'string' || typeof manifest.label !== 'string') {
    throw new Error('engine-version.json missing version/label fields')
  }
  wasmVersion = manifest.version
  engineLabel = manifest.label
  console.log(`cf-build: engine ${engineLabel} from ${WASM_BASE_URL} (cache key ${wasmVersion}, via manifest)`)
} catch (manifestErr) {
  // Manifest not deployed yet (rolls out with the first master deploy that
  // includes the deploy.yml change) or unreachable — fall back to resolving
  // the latest wasm release from the GitHub API, like deploy.yml does.
  try {
    const tag = await resolveLatestWasmTag()
    wasmVersion = tag
    engineLabel = tag.replace(/^wasm-/, '')
    console.log(`cf-build: engine ${engineLabel} from ${WASM_BASE_URL} (cache key ${wasmVersion}, via GitHub API; manifest unavailable: ${manifestErr.message})`)
  } catch (apiErr) {
    console.warn(`cf-build: could not resolve engine version (manifest: ${manifestErr.message}; API: ${apiErr.message}) — falling back to app version ${appVersion} as cache key`)
  }
}

// shell: true so `npx` resolves on both the Linux Cloudflare build image and
// a local Windows checkout.
const result = spawnSync('npx vite build', {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    // No VITE_BASE: the app is served at the Worker's root, so Vite's
    // default base '/' is correct (GitHub Pages sets /OrcaWeb/app/ instead).
    VITE_WASM_BASE_URL: WASM_BASE_URL,
    VITE_WASM_VERSION: wasmVersion,
    VITE_ORCA_VERSION: engineLabel,
  },
})
if (result.error) {
  console.error(`cf-build: failed to spawn vite build: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

// Vite copies public/ verbatim into dist/, including the engine binaries if
// a local checkout has run `npm run setup` (they're gitignored, so a fresh
// Cloudflare build never has them — but a local `npm run build:cf` run
// against a dev checkout would). Strip them here so dist/ always matches
// what Cloudflare actually receives: app shell only, engine loaded
// cross-origin from GitHub Pages. Without this, a local `wrangler deploy`
// run against such a checkout would ship slicer.wasm (~36 MB) and blow past
// Cloudflare's 25 MiB per-asset limit.
for (const name of ['slicer.js', 'slicer.wasm', 'slicer.data', 'slicer.cjs', '.wasm-release-tag']) {
  rmSync(new URL(`../dist/wasm/${name}`, import.meta.url), { force: true })
}
