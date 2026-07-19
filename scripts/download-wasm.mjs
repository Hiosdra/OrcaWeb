#!/usr/bin/env node

/**
 * Downloads pre-built OrcaSlicer WASM artifacts for local development.
 *
 * In CI the WASM module is built from source (orca-wasm/) via the
 * "Build WASM" GitHub Actions workflow and served from the same origin.
 * This script is only needed for local `npm run dev`.
 *
 * Run once: node scripts/download-wasm.mjs
 */

import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { REPO, resolveLatestWasmTag } from './lib/wasm-release.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WASM_DIR = join(__dirname, '../public/wasm')

// approxSize is only used to estimate the download progress bar's total
// (before the real Content-Length header arrives) — NOT to judge whether a
// local file is up to date. That job belongs entirely to TAG_MARKER now
// (below); tying "already present" to a fixed byte threshold meant any
// build that changed the binary's size even slightly (compiler flags, a
// dependency bump) made the check permanently fail and re-download every
// run — exactly what happened here going from ~9 MB to ~36 MB.
const ARTIFACTS = [
  { name: 'slicer.js', approxSize: 220_000 },
  { name: 'slicer.wasm', approxSize: 36_000_000 },
]

// Release-tag resolution (wasm-$ORCA_VERSION / -patchN, with fallback when
// the pinned version has no release yet) lives in lib/wasm-release.mjs —
// shared with cf-build.mjs, which needs the same "which engine build is
// current" answer at Cloudflare build time.

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Marker file recording which release tag public/wasm/ was populated from.
// Without this, "already present, skip" has no way to tell a genuinely
// up-to-date local copy apart from one downloaded before a later -patchN
// release existed — the exact same class of staleness bug fixed for the
// browser's service-worker cache (see slicer.worker.ts) and for
// deploy.yml's release resolution, just on the local dev side.
const TAG_MARKER = join(WASM_DIR, '.wasm-release-tag')

function alreadyPresent(name, tag) {
  const p = join(WASM_DIR, name)
  if (!existsSync(p)) return false
  if (statSync(p).size === 0) return false // guards against a truncated/failed prior write
  if (!existsSync(TAG_MARKER)) return false
  return readFileSync(TAG_MARKER, 'utf8').trim() === tag
}

async function download(name, approxSize, releaseBase, tag) {
  if (alreadyPresent(name, tag)) {
    console.log(`  ✓ ${name} — already present (${tag}), skipping`)
    return
  }

  const url = `${releaseBase}/${name}`
  console.log(`  ↓ Downloading ${name} from ${url}`)

  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${name}`)
  }

  const total = Number(res.headers.get('content-length') ?? approxSize)
  const dest = join(WASM_DIR, name)
  const out = createWriteStream(dest)
  const reader = res.body.getReader()

  let received = 0
  let lastPct = -1

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.write(value)
    received += value.length
    const pct = Math.floor((received / total) * 100)
    if (pct !== lastPct && pct % 10 === 0) {
      process.stdout.write(`\r    ${pct}% (${formatBytes(received)} / ${formatBytes(total)})    `)
      lastPct = pct
    }
  }

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  process.stdout.write(`\r  ✓ ${name} — ${formatBytes(received)}\n`)
}

async function main() {
  console.log('\n  OrcaWeb — WASM artifact downloader')
  console.log('  =====================================\n')

  mkdirSync(WASM_DIR, { recursive: true })

  const tag = await resolveLatestWasmTag()
  console.log(`  Using release: ${tag}\n`)
  const releaseBase = `https://github.com/${REPO}/releases/download/${tag}`

  for (const { name, approxSize } of ARTIFACTS) {
    await download(name, approxSize, releaseBase, tag)
  }
  writeFileSync(TAG_MARKER, `${tag}\n`)

  // Mirror the engine-version.json that deploy.yml publishes next to the
  // engine on gh-pages (version = sha256 of the wasm bytes, first 16 hex;
  // label = the resolved release tag). The worker resolves the engine version
  // + header label from this manifest at RUNTIME (see slicer.worker.ts), so
  // writing it here means local `npm run dev` and the e2e smoke run (which
  // does `npm run setup`) exercise that real runtime-resolution path — and
  // show the actual engine version in the header — instead of silently
  // falling back to the build-time baked app version.
  const version = createHash('sha256')
    .update(readFileSync(join(WASM_DIR, 'slicer.wasm')))
    .digest('hex')
    .slice(0, 16)
  const label = tag.replace(/^wasm-/, '')
  writeFileSync(join(WASM_DIR, 'engine-version.json'), `${JSON.stringify({ label, version })}\n`)

  console.log('\n  All artifacts ready.')
  console.log('  Run `npm run dev` to start the web UI\n')
}

main().catch((err) => {
  console.error('\n  Error:', err.message)
  process.exit(1)
})
