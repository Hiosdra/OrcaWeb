import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Voron Design Cube v7 — a real-world calibration print, not a synthetic
// primitive. Vendored under GPL-3.0 (see NOTICE.md); this is the exact
// model that historically triggered two production crashes in the Arachne
// wall generator (see orca-wasm/patches/apply.py sections 8/8c and
// mkdocs-docs/adr/adr-009-wasm-smoke-test.md) — a stronger regression guard
// for the UI path than a trivial synthetic mesh. See ADR-010 for why
// vendoring it here (unlike orca-wasm/scripts/smoke-test.mjs's synthetic
// icosphere) is safe: GPL-3.0 and this repo's AGPL-3.0-or-later are
// FSF-designed to be combinable.
const VORON_CUBE_STL = join(__dirname, 'fixtures', 'voron-design-cube-v7.stl')

/**
 * Real-WASM-engine UI smoke test — see mkdocs-docs/adr/adr-010-e2e-smoke-test.md.
 *
 * Exercises the actual app path (file upload → worker → WASM engine → G-code),
 * not just that the engine itself can slice (that's covered at the Node level
 * by orca-wasm/scripts/smoke-test.mjs, which never touches the worker message
 * protocol or the UI). Requires a real compiled slicer.js/slicer.wasm in
 * public/wasm/ — run `npm run setup` first (the CI workflow does this before
 * invoking Playwright).
 */
test('uploads the Voron Cube and slices it end-to-end through the UI', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')

  await page.getByTestId('model-file-input').setInputFiles(VORON_CUBE_STL)

  await page.getByTestId('tab-slice').click()
  await page.getByTestId('slice-all-button').click()

  // Cold engine load (fetch + instantiate slicer.wasm) plus a real slice —
  // generous timeout to absorb CI variance, not indicative of expected latency.
  await expect(page.getByTestId('queue-item-status')).toContainText('Done', { timeout: 120_000 })
  await expect(page.getByTestId('download-gcode-button')).toBeVisible()
  await page.getByTitle('Preview G-code').click()
  await expect(page.getByText('Layer', { exact: true })).toBeVisible()

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([])
})
