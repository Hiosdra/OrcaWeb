import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Allow large WASM files without size warnings
  build: {
    chunkSizeWarningLimit: 10000,
  },
  // Serve .wasm and .data with correct MIME types
  assetsInclude: ['**/*.wasm'],
})
