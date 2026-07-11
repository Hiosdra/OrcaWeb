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
 * (VITE_ORCA_VERSION) are resolved from the latest published wasm release,
 * same as deploy.yml does — not from package.json, whose version doesn't
 * change when an engine-only fix ships (the exact staleness bug the ?v= key
 * exists to prevent; see vite.config.ts). Resolution is best-effort: a
 * GitHub API failure (Cloudflare's shared build egress IPs can hit the
 * unauthenticated rate limit) degrades to the app version as the cache key
 * rather than failing the deploy.
 *
 * Run via `npm run build:cf` — this is what the Cloudflare Workers Builds
 * "build command" must be set to (see mkdocs-docs/architecture.md).
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ORCA_VERSION, REPO, resolveLatestWasmTag } from './lib/wasm-release.mjs'

const [owner, repo] = REPO.split('/')
const WASM_BASE_URL = `https://${owner.toLowerCase()}.github.io/${repo}/app/wasm`

const { version: appVersion = '0.0.0' } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
)

let wasmVersion = appVersion
let engineLabel = `${ORCA_VERSION} (via GitHub Pages, unresolved)`
try {
  const tag = await resolveLatestWasmTag()
  wasmVersion = tag
  engineLabel = tag.replace(/^wasm-/, '')
  console.log(`cf-build: engine ${engineLabel} from ${WASM_BASE_URL} (cache key ${wasmVersion})`)
} catch (err) {
  console.warn(`cf-build: could not resolve latest wasm release (${err.message}) — falling back to app version ${appVersion} as cache key`)
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
process.exit(result.status ?? 1)
