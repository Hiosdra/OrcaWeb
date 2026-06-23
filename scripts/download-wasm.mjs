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

import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WASM_DIR = join(__dirname, '../public/wasm')
// Our self-built OrcaSlicer v2.4.0 engine (built by build-wasm.yml, published
// to the wasm-v2.4.0 release).  It has no slicer.data — the orca/resources
// preload was dropped because headless slicing never reads it.
const RELEASE_BASE = 'https://github.com/Hiosdra/OrcaWeb/releases/download/wasm-v2.4.0'

const ARTIFACTS = [
  { name: 'slicer.js',   approxSize: 1_500_000 },
  { name: 'slicer.wasm', approxSize: 9_000_000 },
]

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function alreadyPresent(name, approxSize) {
  const p = join(WASM_DIR, name)
  if (!existsSync(p)) return false
  const size = statSync(p).size
  return size > approxSize * 0.9
}

async function download(name, approxSize) {
  if (alreadyPresent(name, approxSize)) {
    console.log(`  ✓ ${name} — already present, skipping`)
    return
  }

  const url = `${RELEASE_BASE}/${name}`
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

  for (const { name, approxSize } of ARTIFACTS) {
    await download(name, approxSize)
  }

  console.log('\n  All artifacts ready.')
  console.log('  Run `npm run dev` to start the web UI')
  console.log('  Run `node cli/src/index.ts slice --help` to use the CLI\n')
}

main().catch(err => {
  console.error('\n  Error:', err.message)
  process.exit(1)
})
