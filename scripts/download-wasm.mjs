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

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WASM_DIR = join(__dirname, '../public/wasm')
// Must match build-wasm.yml's/deploy.yml's ORCA_VERSION default — bump all
// three together when upgrading the upstream OrcaSlicer version.
const ORCA_VERSION = 'v2.4.2'
const REPO = 'Hiosdra/OrcaWeb'

// approxSize is only used to estimate the download progress bar's total
// (before the real Content-Length header arrives) — NOT to judge whether a
// local file is up to date. That job belongs entirely to TAG_MARKER now
// (below); tying "already present" to a fixed byte threshold meant any
// build that changed the binary's size even slightly (compiler flags, a
// dependency bump) made the check permanently fail and re-download every
// run — exactly what happened here going from ~9 MB to ~36 MB.
const ARTIFACTS = [
  { name: 'slicer.js',   approxSize: 220_000 },
  { name: 'slicer.wasm', approxSize: 36_000_000 },
]

// Releases are immutable (see build-wasm.yml): the first build for
// ORCA_VERSION publishes "wasm-$ORCA_VERSION", every later fix to
// orca-wasm/ for the same ORCA_VERSION publishes "wasm-$ORCA_VERSION-patchN"
// as a new release rather than overwriting the previous one. Resolve
// whichever has the highest patch number (or the base tag if no patches
// exist yet) so local dev always gets the latest engine build.
// Plain string comparisons rather than a regex — baseTag ("wasm-v2.4.0")
// contains "." which is a regex metacharacter; matching it literally this
// way sidesteps needing to escape it correctly rather than risking getting
// that escaping subtly wrong.
async function resolveLatestWasmTag() {
  const baseTag = `wasm-${ORCA_VERSION}`
  const patchPrefix = `${baseTag}-patch`
  // Opportunistically authenticate if a token is available (CI always has
  // one; local devs might). Unauthenticated GitHub API calls are capped at
  // 60/hour — easy to hit if this script runs often (e.g. every checkout).
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} listing releases`)
  const releases = await res.json()

  let best = null
  let bestPatch = -1
  for (const r of releases) {
    const tag = r.tag_name
    let patch
    if (tag === baseTag) {
      patch = 0
    } else if (tag.startsWith(patchPrefix)) {
      const n = Number(tag.slice(patchPrefix.length))
      if (!Number.isInteger(n) || n < 1) continue
      patch = n
    } else {
      continue
    }
    if (patch > bestPatch) {
      bestPatch = patch
      best = tag
    }
  }
  if (!best) throw new Error(`No release found matching ${baseTag}(-patchN)`)
  return best
}

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

  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()))
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

  console.log('\n  All artifacts ready.')
  console.log('  Run `npm run dev` to start the web UI\n')
}

main().catch(err => {
  console.error('\n  Error:', err.message)
  process.exit(1)
})
