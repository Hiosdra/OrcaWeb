import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

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

test('slices a model with the imported Voron dual-nozzle PETG slot and downloads G-code', async ({ page }) => {
  await page.addInitScript(() => {
    const messages: unknown[] = []
    ;(window as typeof window & { __sliceMessages: unknown[] }).__sliceMessages = messages
    const originalPostMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message, options) {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'SLICE') messages.push(message)
      return originalPostMessage.call(this, message, options)
    }
  })
  await page.goto('/')
  await page.getByTestId('model-file-input').setInputFiles(VORON_CUBE_STL)
  await page.getByTestId('tab-settings').click()

  const json = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
  await page.getByTestId('profile-file-input').setInputFiles([
    {
      name: 'Voron 0.4.json',
      mimeType: 'application/json',
      buffer: json({
        name: 'Voron 0.4',
        inherits: 'Voron 2.4 350 0.4 nozzle',
        nozzle_diameter: ['0.4', '0.4'],
        printable_area: ['0x0', '350x0', '350x356', '0x356'],
        machine_start_gcode:
          'SET_PRINT_STATS_INFO TOTAL_LAYER=[total_layer_count]\nM104 S0\nM140 S0\nPRINT_START TOOL_TEMP={first_layer_temperature[initial_tool]} {if is_extruder_used[0]}T0_TEMP={first_layer_temperature[0]}{endif} {if is_extruder_used[1]}T1_TEMP={first_layer_temperature[1]}{endif} BED_TEMP=[first_layer_bed_temperature] TOOL=[initial_tool]',
        layer_change_gcode:
          ';AFTER_LAYER_CHANGE\n;[layer_z]\nSET_PRINT_STATS_INFO CURRENT_LAYER={layer_num + 1}\nM117 Layer {layer_num+1}/[total_layer_count] : {filament_settings_id[0]}',
        change_filament_gcode: 'M104 S{new_filament_temp} T{next_extruder}\nT{next_extruder}',
      }),
    },
    {
      name: '0.20mm Tuned.json',
      mimeType: 'application/json',
      buffer: json({
        name: '0.20mm Tuned',
        inherits: '0.20mm Standard @Voron',
        layer_height: '0.2',
        print_extruder_id: ['1'],
        outer_wall_speed: '150',
      }),
    },
    {
      name: 'Voron PLA.json',
      mimeType: 'application/json',
      buffer: json({
        name: 'Voron PLA',
        inherits: 'Generic PLA @System',
        nozzle_temperature: ['210'],
        nozzle_temperature_initial_layer: ['210'],
        pressure_advance: ['0.03'],
        filament_max_volumetric_speed: ['29'],
      }),
    },
    {
      name: 'Voron PETG.json',
      mimeType: 'application/json',
      buffer: json({
        name: 'Voron PETG',
        inherits: 'Generic PETG @System',
        nozzle_temperature: ['240'],
        nozzle_temperature_initial_layer: ['240'],
        pressure_advance: ['0.07'],
        filament_max_volumetric_speed: ['25'],
        filament_flow_ratio: ['0.98'],
        filament_start_gcode: ['; Filament gcode\n; SET_GCODE_OFFSET Z=0.02'],
        filament_end_gcode: ['; filament end gcode\n; SET_GCODE_OFFSET Z=0.0'],
      }),
    },
  ])

  await expect(page.getByTestId('settings-notice')).toContainText('profile set')
  await expect(page.locator('select').nth(2)).toHaveValue('Voron PETG')
  // `Voron 2.4 350` lives in the private `inherits` parent, which the browser
  // intentionally does not fetch. Verify the production escape hatch: the
  // operator can confirm/correct the Z height and the value reaches the engine
  // instead of being only a display field.
  const maxHeight = page.getByTestId('setting-printable_height')
  await maxHeight.fill('350')
  await maxHeight.blur()
  await expect(maxHeight).toHaveValue('350')
  await page.getByTestId('tab-slice').click()
  await page.getByTestId('extruder-select').selectOption('2')
  await page.getByTestId('slice-all-button').click()
  await expect(page.getByTestId('queue-item-status')).toContainText('Done', { timeout: 120_000 })

  await expect.poll(() => page.evaluate(() => {
    const messages = (window as typeof window & {
      __sliceMessages: Array<{ config?: { printable_height?: number; _passthrough?: Record<string, unknown> } }>
    }).__sliceMessages
    return messages.at(-1)?.config?._passthrough ?? null
  })).toMatchObject({
    filament_type: ['PLA', 'PETG'],
    nozzle_temperature: ['210', '240'],
    nozzle_temperature_initial_layer: ['210', '240'],
    filament_map: ['1', '2'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive Standard'],
    filament_self_index: ['1', '2'],
  })
  await expect.poll(() => page.evaluate(() => {
    const messages = (window as typeof window & {
      __sliceMessages: Array<{ config?: { printable_height?: number } }>
    }).__sliceMessages
    return messages.at(-1)?.config?.printable_height ?? null
  })).toBe(350)

  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('download-gcode-button').click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  const gcode = await readFile(downloadPath as string, 'utf8')
  const startup = gcode.split('\n').slice(0, 40).join('\n')
  expect(startup).toContain('PRINT_START')
  // Only slot 2 is used by this one-object job, so the machine macro
  // correctly emits T1_TEMP and omits the unused T0_TEMP argument.
  expect(startup).toContain('T1_TEMP=240')
  expect(startup).toMatch(/M104 S240 T1/)
  expect(startup).toMatch(/(?:^|\n)T1(?:\s|$)/m)
  expect(gcode).toContain('SET_GCODE_OFFSET Z=0.02')
  expect(gcode).toContain('SET_GCODE_OFFSET Z=0.0')
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
