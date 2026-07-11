/**
 * Shared WASM-release resolution — used by download-wasm.mjs (local dev /
 * e2e setup) and cf-build.mjs (Cloudflare Workers build).
 */

// Must match build-wasm.yml's/deploy.yml's ORCA_VERSION default — bump all
// of them together when upgrading the upstream OrcaSlicer version.
export const ORCA_VERSION = 'v2.4.2'
export const REPO = 'Hiosdra/OrcaWeb'

// Releases are immutable (see build-wasm.yml): the first build for
// ORCA_VERSION publishes "wasm-$ORCA_VERSION", every later fix to
// orca-wasm/ for the same ORCA_VERSION publishes "wasm-$ORCA_VERSION-patchN"
// as a new release rather than overwriting the previous one. Resolve
// whichever has the highest patch number (or the base tag if no patches
// exist yet) so callers always get the latest engine build.
// Plain string comparisons rather than a regex — baseTag ("wasm-v2.4.0")
// contains "." which is a regex metacharacter; matching it literally this
// way sidesteps needing to escape it correctly rather than risking getting
// that escaping subtly wrong.
export async function resolveLatestWasmTag() {
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
  if (best) return best

  // No release published yet for the currently pinned ORCA_VERSION — e.g.
  // right after bumping it in a PR, before build-wasm.yml has ever run for
  // it. deploy.yml already handles this identical gap (falls back to the
  // previous gh-pages deploy) for the same reason: a version bump landing
  // shouldn't hard-block every other PR/local dev just because the new
  // engine hasn't been built and published yet. Fall back to whichever
  // wasm-v* release is newest overall (the GitHub API returns releases
  // newest-first) — for local dev that's a working, if not-yet-current,
  // engine; for e2e-smoke.yml it's still a real published binary to drive
  // the UI against, which is all that check needs (see ADR-010 — it
  // validates the UI/worker glue, not the pinned engine version itself).
  const fallback = releases.find(r => r.tag_name.startsWith('wasm-v'))
  if (!fallback) {
    throw new Error(`No release found matching ${baseTag}(-patchN), and no other wasm-v* release exists to fall back to`)
  }
  console.warn(`  ⚠ No release found matching ${baseTag}(-patchN) — falling back to latest published release: ${fallback.tag_name}\n`)
  return fallback.tag_name
}
