import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const { version = '0.0.0' } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
const RELEASE_DATE = process.env.VITE_RELEASE_DATE ?? new Date().toISOString().slice(0, 10)
// Identifies the actual WASM engine build (the resolved GitHub Release tag,
// e.g. "wasm-v2.4.0-patch2" — see deploy.yml's "Download WASM artifacts" step)
// rather than the app's own package.json version. The two version cycles are
// decoupled: a bridge/engine-only change bumps this without touching
// package.json, so the slicer.worker.ts cache-busting query param always
// changes when the engine binary does, even if nobody remembers to cut an
// app release. Falls back to the app version for local dev, where there's no
// deploy-time WASM_TAG and the PWA service worker is disabled anyway.
const WASM_VERSION = process.env.VITE_WASM_VERSION ?? version
// The actually-resolved WASM release tag (e.g. "v2.4.2-patch2") — a
// human-readable label for the UI, distinct from WASM_VERSION above (which is
// a cache-busting key, not something worth showing anyone). Set by deploy.yml
// from $ENGINE_LABEL, which reflects the specific release it downloaded, not
// just the upstream OrcaSlicer target family ($ORCA_VERSION stays "v2.4.2"
// across every patch, so it can't tell you which bridge build is live — see
// the "Download WASM artifacts" step). The fallback here is for local dev
// only, where there's no resolved release to report.
const ORCA_ENGINE_VERSION = process.env.VITE_ORCA_VERSION ?? 'v2.4.2 (local)'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_RELEASE_DATE__: JSON.stringify(RELEASE_DATE),
    __WASM_VERSION__: JSON.stringify(WASM_VERSION),
    __ORCA_ENGINE_VERSION__: JSON.stringify(ORCA_ENGINE_VERSION),
  },
  // VITE_BASE is set in CI for GitHub Pages (/OrcaWeb/app/); locally it's /
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Exclude wasm/ from precache — slicer.js + slicer.wasm must be cached
        // together via runtimeCaching so they always come from the same build.
        // Precaching only slicer.js (via **/*.js) would cause ABI mismatches
        // after deploys: new slicer.js paired with a 30-day-old slicer.wasm.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['wasm/**'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // slicer.(js|wasm) (ST) + slicer-mt.(js|wasm) (MT, real oneTBB —
            // see orca-wasm/MT-PLAN.md) — CacheFirst so SW installs without
            // downloading the full engine bundle upfront; each variant's pair
            // is cached on first use and stays version-matched, sharing the
            // same 30-day TTL. Both are fetched with a ?v=<wasm-version>
            // cache-busting query param (slicer.worker.ts, __WASM_VERSION__)
            // so a new engine build's URL is a fresh cache entry rather than
            // CacheFirst indefinitely reusing a stale pre-release binary —
            // match the optional query string here too.
            urlPattern: /\/wasm\/slicer(-mt)?\.(js|wasm)(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-assets',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Same engine files fetched CROSS-origin — the Cloudflare mirror
            // deploy loads them from GitHub Pages (scripts/cf-build.mjs sets
            // VITE_WASM_BASE_URL; both slicer.wasm and slicer-mt.wasm exceed
            // Cloudflare's 25 MiB per-asset limit so neither can be served
            // same-origin there). The Cloudflare mirror sends COOP/COEP
            // (public/_headers), so it's the one host that actually fetches
            // slicer-mt.* at runtime (slicer.worker.ts's canUseThreads probe).
            // A separate, origin-anchored pattern is required: Workbox only
            // applies RegExp routes to cross-origin requests when the match
            // starts at the first character of the URL, so the same-origin
            // pattern above never fires for these (verified live — the
            // wasm-assets cache stayed empty on a cf-build until this entry
            // was added). Without it every cold visit on the mirror
            // re-downloads the ~36 MB binary (GitHub Pages caps HTTP caching
            // at max-age=600).
            urlPattern: /^https:\/\/[^/]+\.github\.io\/.*\/wasm\/slicer(-mt)?\.(js|wasm)(\?.*)?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-assets',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: {
        name: 'OrcaWeb — Browser Slicer',
        short_name: 'OrcaWeb',
        description: 'Slice 3D models in your browser using OrcaSlicer',
        theme_color: '#0a84ff',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        // Disable SW in dev — avoids conflicts with COOP/COEP headers
        enabled: false,
      },
    }),
  ],
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    chunkSizeWarningLimit: 10000,
  },
  optimizeDeps: {
    exclude: ['occt-import-js'],
  },
  assetsInclude: ['**/*.wasm'],
})
