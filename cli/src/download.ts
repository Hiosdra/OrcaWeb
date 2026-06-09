import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const WASM_DIR = join(__dirname, '../../public/wasm')

const RELEASE_BASE = 'https://github.com/allanwrench28/orcaslicer-wasm/releases/download/v1.1'

const ARTIFACTS = [
  { name: 'slicer.js',   size: 1_200_000   },
  { name: 'slicer.wasm', size: 6_400_000   },
  { name: 'slicer.data', size: 144_000_000 },
] as const

export async function ensureWasmArtifacts(
  onProgress?: (name: string, percent: number) => void,
): Promise<void> {
  mkdirSync(WASM_DIR, { recursive: true })

  for (const artifact of ARTIFACTS) {
    const dest = join(WASM_DIR, artifact.name)

    if (existsSync(dest) && statSync(dest).size > artifact.size * 0.9) {
      continue // Already downloaded
    }

    const url = `${RELEASE_BASE}/${artifact.name}`
    const res = await fetch(url, { redirect: 'follow' })

    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ${artifact.name}: HTTP ${res.status}`)
    }

    const total = Number(res.headers.get('content-length') ?? artifact.size)
    let received = 0

    const out = createWriteStream(dest)
    const reader = res.body.getReader()

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        out.write(value)
        received += value.length
        if (onProgress) {
          onProgress(artifact.name, Math.round((received / total) * 100))
        }
      }
    } finally {
      reader.releaseLock()
      await new Promise<void>((resolve, reject) =>
        out.end((err: Error | null) => (err ? reject(err) : resolve())),
      )
    }
  }
}

export function wasmArtifactsPresent(): boolean {
  return ARTIFACTS.every(({ name, size }) => {
    const p = join(WASM_DIR, name)
    return existsSync(p) && statSync(p).size > size * 0.9
  })
}

// Suppress unused import warning
void pipeline
