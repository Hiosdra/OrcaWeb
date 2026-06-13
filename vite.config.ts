import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // VITE_BASE is set in CI for GitHub Pages (/OrcaWeb/app/); locally it's /
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Pre-cache lightweight app shell; WASM is handled via runtimeCaching
        // below so a failed 15 MB download doesn't abort SW installation.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // slicer.wasm (~15 MB) — cache on first use (CacheFirst) so the
            // file is available offline after the initial visit without risking
            // SW install failure on slow/unstable connections.
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-assets',
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
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
  assetsInclude: ['**/*.wasm'],
})
