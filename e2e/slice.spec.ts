import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cubeStlBuffer } from './fixtures/cube-stl'

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
test('uploads a model and slices it end-to-end through the UI', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')

  const stlDir = mkdtempSync(join(tmpdir(), 'orcaweb-e2e-'))
  const stlPath = join(stlDir, 'smoke-cube.stl')
  writeFileSync(stlPath, cubeStlBuffer())

  await page.getByTestId('model-file-input').setInputFiles(stlPath)

  await page.getByTestId('tab-slice').click()
  await page.getByTestId('slice-all-button').click()

  // Cold engine load (fetch + instantiate slicer.wasm) plus a real slice —
  // generous timeout to absorb CI variance, not indicative of expected latency.
  await expect(page.getByTestId('queue-item-status')).toContainText('Done', { timeout: 120_000 })
  await expect(page.getByTestId('download-gcode-button')).toBeVisible()

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([])
})
