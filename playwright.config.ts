import { defineConfig, devices } from '@playwright/test'

// Real-WASM-engine E2E smoke test — see mkdocs-docs/adr/adr-010-e2e-smoke-test.md.
// Runs against the Vite dev server (not `vite preview`) because vite.config.ts's
// COOP/COEP headers live under `server`, not `preview`.
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
