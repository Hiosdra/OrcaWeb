import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // VITE_BASE is set in CI for GitHub Pages (/OrcaWeb/app/); locally it's /
  base: process.env.VITE_BASE ?? '/',
  plugins: [tailwindcss(), react()],
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
