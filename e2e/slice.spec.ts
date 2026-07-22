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

test('keeps an imported machine profile active when the filament changes', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('model-file-input').setInputFiles(VORON_CUBE_STL)
  await page.getByTestId('tab-settings').click()

  await page.getByTestId('profile-file-input').setInputFiles({
    name: 'Voron 350.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      type: 'machine',
      name: 'Voron 350',
      printer_model: 'Voron 2 350',
      printable_area: '0x0,350x0,350x350,0x350',
    })),
  })

  const profileChip = page.getByText(/Profile: Voron 350/)
  await expect(profileChip).toBeVisible()
  const selects = page.locator('select')
  await expect(selects.nth(0)).toHaveValue('Imported: Voron 350')

  await selects.nth(1).selectOption('PETG')

  await expect(profileChip).toBeVisible()
  await expect(selects.nth(0)).toHaveValue('Imported: Voron 350')
  await page.getByTitle('Remove imported profile').click()
  await expect(profileChip).toBeHidden()
})

test('keeps a manual setting when presets underneath it change', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('model-file-input').setInputFiles(VORON_CUBE_STL)
  await page.getByTestId('tab-settings').click()

  const skirt = page.getByTestId('setting-skirt_loops')
  await skirt.fill('0')
  await skirt.blur()
  await expect(skirt).toHaveValue('0')
  await expect(page.getByTestId('override-summary')).toContainText('1 setting changed by you')

  // Quality chips are buttons, so clicking the already-selected one is the
  // exact interaction that used to clear manualOverrides without changing
  // the visible preset selection.
  await page.getByRole('button', { name: /Standard/ }).click()
  await page.locator('select').nth(0).selectOption('Prusa MK4')
  await page.locator('select').nth(1).selectOption('PETG')

  await expect(skirt).toHaveValue('0')
  await expect(page.getByTestId('revert-skirt_loops')).toBeVisible()
})

test('adds a filament slot and offers it as a per-object assignment', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('model-file-input').setInputFiles(VORON_CUBE_STL)
  await page.getByTestId('tab-settings').click()

  // A single slot is the old "Material" dropdown, and nothing on the Slice tab
  // offers a choice — the picker only earns its space above one slot.
  await page.getByTestId('tab-slice').click()
  await expect(page.getByTestId('extruder-select')).toBeHidden()
  await expect(page.getByText(/\(\d+ slots\)/)).toBeHidden()

  await page.getByTestId('tab-settings').click()
  await page.getByTestId('add-filament-slot').click()
  const filamentSelects = page.locator('select')
  // A new slot takes the first unused material rather than duplicating slot 1,
  // which would give the engine two slots to purge 280 mm³ between for nothing.
  await expect(filamentSelects.nth(1)).not.toHaveValue(await filamentSelects.nth(2).inputValue())

  await page.getByTestId('tab-slice').click()
  const picker = page.getByTestId('extruder-select')
  await expect(picker).toBeVisible()
  await expect(picker.locator('option')).toHaveCount(3) // Auto + one per slot
  // The summary counts the same slots the picker does. It used to split the
  // display scalar instead, which for panel-defined slots is slot 1's material
  // alone — so it read a single material beside a picker offering two.
  await expect(page.getByText(/\(2 slots\)/)).toBeVisible()
  await picker.selectOption('2')
  await expect(picker).toHaveValue('2')

  // Removing the slot again leaves nothing naming it: the picker disappears,
  // and the assignment behind it is dropped rather than left pointing at a
  // filament the engine no longer has (buildPlateExtruderIds would still send
  // it, and the engine would index its per-filament vectors out of range).
  await page.getByTestId('tab-settings').click()
  await page.getByLabel('Remove filament slot 2').click()
  await page.getByTestId('tab-slice').click()
  await expect(page.getByTestId('extruder-select')).toBeHidden()
  await expect(page.getByText(/\(\d+ slots\)/)).toBeHidden()

  await page.getByTestId('tab-settings').click()
  await page.getByTestId('add-filament-slot').click()
  await page.getByTestId('tab-slice').click()
  await expect(page.getByTestId('extruder-select')).toHaveValue('0')
})

test('offers a reset for a manual setting hidden by its parent option', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('model-file-input').setInputFiles(VORON_CUBE_STL)
  await page.getByTestId('tab-settings').click()
  await page.getByRole('button', { name: 'Show advanced settings' }).click()

  const fuzzySkin = page.getByTestId('setting-fuzzy_skin')
  await fuzzySkin.selectOption('external')
  const thickness = page.getByTestId('setting-fuzzy_skin_thickness')
  await thickness.fill('1')
  await thickness.blur()
  await expect(page.getByTestId('revert-fuzzy_skin_thickness')).toBeVisible()

  await fuzzySkin.selectOption('none')
  await expect(page.getByTestId('override-summary')).toContainText('Fuzzy skin thickness')
  await page.getByTestId('revert-fuzzy_skin_thickness').click()
  await expect(page.getByTestId('override-summary')).not.toContainText('Fuzzy skin thickness')
})
