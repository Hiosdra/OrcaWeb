#!/usr/bin/env node
/**
 * Phase-1 (offline size) benchmark for mkdocs-docs/gcode-compression-benchmark.md.
 *
 * Takes the corpus produced by scripts/generate-corpus.mjs and measures, for
 * every (base format x compressor x level) cell in the pruned matrix, the
 * resulting byte size — the primary bandwidth metric. Emits a Markdown
 * results table on stdout.
 *
 * External tools are shelled out to (gzip, brotli, zstd, xz, bzip2, 7z) so
 * the reported ratios match what a real deployment would get from these
 * exact binaries/algorithms, not a JS re-implementation of them. MeatPack is
 * a from-scratch adaptive re-implementation of the *mechanism* (4-bit
 * packing of the most frequent bytes) rather than upstream's fixed 15-symbol
 * table — see the "Deviations from the original plan" section of the doc.
 * Prusa bgcode's block compression is approximated by running the same
 * heatshrink core algorithm (via Python's heatshrink2) at bgcode's two
 * documented profiles directly on the raw G-code text — a real, accurate
 * measurement of the compression backend, without the container framing
 * (block headers/checksums/thumbnails), which is fixed overhead in the tens
 * of bytes and negligible at these file sizes.
 *
 * Usage:
 *   node scripts/benchmark-gcode-compression.mjs [--corpus-dir <dir>]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'

function parseArgs(argv) {
  const args = { corpusDir: 'corpus', out: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus-dir') args.corpusDir = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
  }
  return args
}

// ── shell-out helpers ─────────────────────────────────────────────────────────

function run(cmd, args, input) {
  const res = spawnSync(cmd, args, { input, maxBuffer: 1024 * 1024 * 1024 })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr?.toString().slice(0, 500)}`)
  }
  return res.stdout
}

function gzipCli(buf, level) {
  return run('gzip', [`-${level}`, '-c'], buf).length
}

function brotliCli(buf, quality) {
  return run('brotli', ['-q', String(quality), '-c'], buf).length
}

function zstdCli(buf, level, ultra) {
  const args = ultra ? ['--ultra', `-${level}`, '-c'] : [`-${level}`, '-c']
  return run('zstd', args, buf).length
}

function xzCli(buf, levelArg) {
  return run('xz', [`-${levelArg}`, '-c'], buf).length
}

function bzip2Cli(buf) {
  return run('bzip2', ['-9', '-c'], buf).length
}

function sevenZipPpmdCli(buf, tmpPath) {
  run('7z', ['a', '-mx9', '-m0=PPMd', tmpPath, '-si'], buf)
  const size = readFileSync(tmpPath).length
  spawnSync('rm', ['-f', tmpPath])
  return size
}

function heatshrinkPy(buf, window, lookahead) {
  const res = spawnSync('python3', ['-c', `
import sys, heatshrink2
data = sys.stdin.buffer.read()
out = heatshrink2.compress(data, window_sz2=${window}, lookahead_sz2=${lookahead})
sys.stdout.buffer.write(out)
`], { input: buf, maxBuffer: 1024 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`heatshrink2 failed: ${res.stderr?.toString().slice(0, 500)}`)
  return res.stdout.length
}

// ── native Node codecs (no subprocess needed) ─────────────────────────────────

function gzipNodeDefault(buf) {
  // Approximates the browser's native CompressionStream('gzip'), which
  // offers no level knob and runs at zlib's default (level 6).
  return gzipSync(buf, { level: 6 }).length
}

function brotliNodeQ11(buf) {
  return brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length
}

// ── format transforms ─────────────────────────────────────────────────────────

function stripComments(text) {
  const lines = text.split('\n')
  const out = []
  for (const line of lines) {
    const idx = line.indexOf(';')
    const kept = idx === -1 ? line : line.slice(0, idx).trimEnd()
    if (kept.length > 0) out.push(kept)
  }
  return out.join('\n')
}

// Adaptive MeatPack-style 4-bit packer: builds its symbol table from this
// file's own byte-frequency histogram (top 15 bytes -> nibble codes 0-14,
// nibble 15 = escape-then-raw-byte) rather than reciting upstream's fixed
// table from memory. Round-trip-verified below so a wrong implementation
// would fail loudly instead of silently reporting bogus ratios.
function meatpackAdaptiveEncode(buf) {
  const freq = new Uint32Array(256)
  for (const b of buf) freq[b]++
  const table = [...freq.keys()].sort((a, b) => freq[b] - freq[a]).slice(0, 15)
  const codeOf = new Int16Array(256).fill(-1)
  table.forEach((byte, code) => { codeOf[byte] = code })

  const nibbles = []
  for (const b of buf) {
    const code = codeOf[b]
    if (code >= 0) {
      nibbles.push(code)
    } else {
      nibbles.push(15, (b >> 4) & 0xf, b & 0xf)
    }
  }
  const packed = new Uint8Array(15 + 4 + Math.ceil(nibbles.length / 2))
  packed.set(table, 0) // 15-byte table header
  new DataView(packed.buffer).setUint32(15, buf.length, true) // original length, for decode
  let outOff = 19
  for (let i = 0; i < nibbles.length; i += 2) {
    const hi = nibbles[i]
    const lo = i + 1 < nibbles.length ? nibbles[i + 1] : 0
    packed[outOff++] = (hi << 4) | lo
  }
  return packed
}

function meatpackAdaptiveDecode(packed) {
  const table = packed.slice(0, 15)
  const origLen = new DataView(packed.buffer, packed.byteOffset).getUint32(15, true)
  const nibbles = []
  for (let i = 19; i < packed.length; i++) {
    nibbles.push((packed[i] >> 4) & 0xf, packed[i] & 0xf)
  }
  const out = new Uint8Array(origLen)
  let outPos = 0, i = 0
  while (outPos < origLen) {
    const code = nibbles[i++]
    if (code === 15) {
      const hi = nibbles[i++], lo = nibbles[i++]
      out[outPos++] = (hi << 4) | lo
    } else {
      out[outPos++] = table[code]
    }
  }
  return out
}

// ── per-file benchmark ─────────────────────────────────────────────────────────

function benchmarkFile(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const raw = readFileSync(filePath) // Buffer, for byte-exact tools
  const stripped = Buffer.from(stripComments(text), 'utf8')

  const meatpack = meatpackAdaptiveEncode(raw)
  const roundTrip = meatpackAdaptiveDecode(meatpack)
  const meatpackOk = Buffer.compare(Buffer.from(roundTrip), raw) === 0
  if (!meatpackOk) throw new Error(`${filePath}: MeatPack-adaptive round-trip check FAILED`)

  const tmp7z = `/tmp/bench-${process.pid}-${Math.random().toString(36).slice(2)}.7z`

  const results = {
    file: basename(filePath),
    rawBytes: raw.length,
    candidates: {
      'F1 raw (baseline)': raw.length,
      'F1 x gzip (native default, ~lvl6)': gzipNodeDefault(raw),
      'F1 x gzip -1': gzipCli(raw, 1),
      'F1 x gzip -9': gzipCli(raw, 9),
      'F1 x brotli -q5': brotliCli(raw, 5),
      'F1 x brotli -q9': brotliCli(raw, 9),
      'F1 x brotli -q11': brotliNodeQ11(raw),
      'F1 x zstd -3': zstdCli(raw, 3, false),
      'F1 x zstd -19': zstdCli(raw, 19, false),
      'F1 x zstd --ultra -22': zstdCli(raw, 22, true),
      'F1 x xz -6': xzCli(raw, 6),
      'F1 x xz -9e': xzCli(raw, '9e'),
      'F1 x bzip2 -9 (ref bound)': bzip2Cli(raw),
      'F1 x 7z PPMd (ref bound)': sevenZipPpmdCli(raw, tmp7z),
      'F2 comments-stripped (raw)': stripped.length,
      'F2 x brotli -q11': brotliNodeQ11(stripped),
      'F2 x zstd -19': zstdCli(stripped, 19, false),
      'F3 MeatPack-adaptive (raw)': meatpack.length,
      'F3 x zstd -19 (stacking check)': zstdCli(Buffer.from(meatpack), 19, false),
      'F4proxy heatshrink(11,4) (bgcode default profile)': heatshrinkPy(raw, 11, 4),
      'F4proxy heatshrink(12,4) (bgcode alt profile)': heatshrinkPy(raw, 12, 4),
      'F4proxy heatshrink(11,4) x zstd -19 (confirm-and-drop)': zstdCli(Buffer.from(run('python3', ['-c', `
import sys, heatshrink2
data = sys.stdin.buffer.read()
sys.stdout.buffer.write(heatshrink2.compress(data, window_sz2=11, lookahead_sz2=4))
`], raw)), 19, false),
    },
  }
  return results
}

function fmtRatio(rawBytes, size) {
  return (rawBytes / size).toFixed(2) + ':1'
}

function main() {
  const { corpusDir, out } = parseArgs(process.argv.slice(2))
  const files = readdirSync(corpusDir).filter((f) => f.endsWith('.gcode')).sort()
  if (files.length === 0) throw new Error(`no .gcode files found in ${corpusDir} — run scripts/generate-corpus.mjs first`)

  const allResults = []
  for (const f of files) {
    process.stderr.write(`[benchmark] ${f} ... `)
    const t0 = Date.now()
    const r = benchmarkFile(resolve(corpusDir, f))
    allResults.push(r)
    process.stderr.write(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`)
  }

  // ── build markdown table: rows = candidates, columns = files ────────────────
  const candidateNames = Object.keys(allResults[0].candidates)
  const header = ['Candidate', ...allResults.map((r) => r.file.replace('.gcode', ''))]
  const lines = []
  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`|${header.map(() => '---').join('|')}|`)
  for (const name of candidateNames) {
    const row = [name]
    for (const r of allResults) {
      const size = r.candidates[name]
      row.push(`${size.toLocaleString()} B (${fmtRatio(r.rawBytes, size)})`)
    }
    lines.push(`| ${row.join(' | ')} |`)
  }

  const md = lines.join('\n')
  console.log(md)
  if (out) {
    writeFileSync(out, JSON.stringify(allResults, null, 2))
    process.stderr.write(`\n[benchmark] raw JSON written to ${out}\n`)
  }
}

main()
