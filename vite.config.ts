import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

const { version = '0.0.0' } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
const RELEASE_DATE = '2026-06-15'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_RELEASE_DATE__: JSON.stringify(RELEASE_DATE),
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
            // slicer.js + slicer.wasm — CacheFirst so SW installs without
            // downloading the full engine bundle (~9 MB) upfront; both files
            // are cached on first use and stay version-matched in the same
            // cache entry, sharing the same 30-day TTL.
            urlPattern: /\/wasm\/slicer\.(js|wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-assets',
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
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
