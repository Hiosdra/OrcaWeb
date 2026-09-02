import { expect, test, type Page } from '@playwright/test'

type SliceRequestConfig = {
  nozzle_temperature?: number
  skirt_loops?: number
  _passthrough?: Record<string, string | string[]>
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const originalArrayBuffer = File.prototype.arrayBuffer
    const delayedReads: Array<(buffer: ArrayBuffer) => void> = []

    Object.assign(window, {
      __delayedReads: delayedReads,
      __sliceRequests: [] as Array<{ type: string; config: SliceRequestConfig; extruderId?: number }>,
    })

    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith('delayed-')) return originalArrayBuffer.call(this)
      return new Promise((resolve) => delayedReads.push(resolve))
    }

    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null

      postMessage(message: { type: string; config?: SliceRequestConfig; extruderId?: number }) {
        if (message.type === 'LOAD_WASM') {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'WASM_LOADED', engineLabel: 'Test' } } as MessageEvent))
          return
        }

        if (message.type === 'SLICE' || message.type === 'SLICE_MULTI') {
          ;(window as typeof window & { __sliceRequests: unknown[] }).__sliceRequests.push({
            type: message.type,
            config: message.config ?? {},
            ...(message.extruderId ? { extruderId: message.extruderId } : {}),
          })
          const type = message.type === 'SLICE' ? 'SLICE_COMPLETE' : 'SLICE_MULTI_COMPLETE'
          queueMicrotask(() => this.onmessage?.({ data: { type, gcode: '; test gcode' } } as MessageEvent))
        }
      }

      terminate() {}
    }

    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: MockWorker,
    })
  })
})

async function releaseDelayedReads(page: Page) {
  await page.waitForFunction(
    () => (window as typeof window & { __delayedReads: unknown[] }).__delayedReads.length > 0,
    undefined,
    { timeout: 5_000 },
  )
  await page.evaluate(() => {
    const state = window as typeof window & { __delayedReads: Array<(buffer: ArrayBuffer) => void> }
    state.__delayedReads.splice(0).forEach((resolve) => resolve(new ArrayBuffer(84)))
  })
}

async function changeSettingsDuringRead(page: Page, temperature = '225') {
  await page.getByTestId('tab-settings').click()
  // By test id, not by walking up from the label text: the label sits in its
  // own row alongside the per-field override "reset" control, so `..` is that
  // row rather than the field wrapper the input lives in.
  const nozzleTemp = page.getByTestId('setting-nozzle_temperature')
  await nozzleTemp.fill(temperature)
  await nozzleTemp.blur()
  await expect(nozzleTemp).toHaveValue(temperature)
}

test('imports a dual-nozzle profile set, assigns PETG to slot 2, and downloads its G-code', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'cable-holder.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
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
        machine_start_gcode: 'PRINT_START',
      }),
    },
    {
      name: '0.20mm Tuned.json',
      mimeType: 'application/json',
      buffer: json({ name: '0.20mm Tuned', layer_height: '0.2', wall_loops: '4' }),
    },
    {
      name: 'Voron PLA.json',
      mimeType: 'application/json',
      buffer: json({
        name: 'Voron PLA',
        nozzle_temperature: ['220'],
        hot_plate_temp: ['55'],
        filament_flow_ratio: ['0.98'],
      }),
    },
    {
      name: 'Voron PETG.json',
      mimeType: 'application/json',
      buffer: json({
        name: 'Voron PETG',
        nozzle_temperature: ['240'],
        hot_plate_temp: ['80'],
        filament_flow_ratio: ['0.97'],
      }),
    },
  ])

  await expect(page.getByTestId('settings-notice')).toContainText('profile set')
  await expect(page.getByText(/Profile: Voron 0\.4 \+ 0\.20mm Tuned \+ Voron PLA \+ Voron PETG/)).toBeVisible()
  const settingsSelects = page.locator('select')
  await expect(settingsSelects.nth(0)).toHaveValue(/Imported: Voron 0\.4/)
  await expect(settingsSelects.nth(1)).toHaveValue('Voron PLA')
  await expect(settingsSelects.nth(2)).toHaveValue('Voron PETG')

  // The imported layer and its slot count are part of the persisted settings,
  // so a normal refresh must not silently fall back to the single-nozzle UI.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'cable-holder.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
  await page.getByTestId('tab-settings').click()
  await expect(page.getByText(/Profile: Voron 0\.4 \+ 0\.20mm Tuned \+ Voron PLA \+ Voron PETG/)).toBeVisible()
  await expect(page.locator('select').nth(1)).toHaveValue('Voron PLA')
  await expect(page.locator('select').nth(2)).toHaveValue('Voron PETG')

  await page.getByTestId('tab-slice').click()
  await page.getByTestId('extruder-select').selectOption('2')
  await page.getByTestId('slice-all-button').click()
  await expect(page.getByTestId('queue-item-status')).toContainText('Done')

  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & {
      __sliceRequests: Array<{ type: string; config: SliceRequestConfig; extruderId?: number }>
    }).__sliceRequests
      .map(({ type, config, extruderId }) => ({
        type,
        extruderId,
        filament_type: config._passthrough?.filament_type,
        filament_map: config._passthrough?.filament_map,
        nozzle_temperature: config._passthrough?.nozzle_temperature,
        hot_plate_temp: config._passthrough?.hot_plate_temp,
        nozzle_diameter: config._passthrough?.nozzle_diameter,
      }))
  )), { timeout: 5_000 }).toEqual([
    {
      type: 'SLICE',
      extruderId: 2,
      filament_type: ['PLA', 'PETG'],
      filament_map: ['1', '2'],
      nozzle_temperature: ['220', '240'],
      hot_plate_temp: ['55', '80'],
      nozzle_diameter: ['0.4', '0.4'],
    },
  ])

  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('download-gcode-button').click()
  expect((await downloadPromise).suggestedFilename()).toBe('cable-holder.gcode')

  // A bad follow-up selection must not partially replace the working set.
  await page.getByTestId('tab-settings').click()
  await page.getByTestId('profile-file-input').setInputFiles([
    {
      name: 'duplicate-a.json',
      mimeType: 'application/json',
      buffer: json({ type: 'machine', name: 'A', nozzle_diameter: ['0.4'] }),
    },
    {
      name: 'duplicate-b.json',
      mimeType: 'application/json',
      buffer: json({ type: 'machine', name: 'B', nozzle_diameter: ['0.6'] }),
    },
  ])
  await expect(page.getByTestId('settings-notice')).toContainText('at most one machine')
  await expect(page.getByText(/Profile: Voron 0\.4 \+ 0\.20mm Tuned \+ Voron PLA \+ Voron PETG/)).toBeVisible()

  await page.getByLabel('Remove filament slot 2').click()
  await expect(page.getByText(/Profile: Voron 0\.4 \+ 0\.20mm Tuned \+ Voron PLA \+ Voron PETG/)).toHaveCount(0)
})

test('drops imported filament vectors before changing a profile-set slot list', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'cable-holder.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
  await page.getByTestId('tab-settings').click()

  const json = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value))
  await page.getByTestId('profile-file-input').setInputFiles([
    {
      name: 'dual-machine.json',
      mimeType: 'application/json',
      buffer: json({ type: 'machine', name: 'Dual machine', nozzle_diameter: ['0.4', '0.4'] }),
    },
    {
      name: 'custom-pla.json',
      mimeType: 'application/json',
      buffer: json({
        type: 'filament',
        name: 'Custom PLA',
        filament_type: ['PLA'],
        nozzle_temperature: ['201'],
        pressure_advance: ['0.031'],
      }),
    },
    {
      name: 'custom-petg.json',
      mimeType: 'application/json',
      buffer: json({
        type: 'filament',
        name: 'Custom PETG',
        filament_type: ['PETG'],
        nozzle_temperature: ['299'],
        pressure_advance: ['0.071'],
      }),
    },
  ])

  await expect(page.getByText(/Profile: Dual machine \+ Custom PLA \+ Custom PETG/)).toBeVisible()
  // Adding a slot changes the meaning/length of every imported per-filament
  // vector. The complete set must be shed before the new slot can slice, so
  // its custom 201/299°C values cannot leak into a three-slot preset config.
  await page.getByTestId('add-filament-slot').click()
  await expect(page.getByText(/Profile: Dual machine \+ Custom PLA \+ Custom PETG/)).toHaveCount(0)

  await page.getByTestId('tab-slice').click()
  await page.getByTestId('slice-all-button').click()
  await expect(page.getByTestId('queue-item-status')).toContainText('Done')
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __sliceRequests: Array<{ config: SliceRequestConfig }> }).__sliceRequests
      .at(-1)?.config._passthrough?.nozzle_temperature
  )), { timeout: 5_000 }).toEqual(['220', '255', '270'])
})

for (const { name, files, button, requestType } of [
  { name: 'single model', files: 1, button: 'slice-all-button', requestType: 'SLICE' },
  { name: 'plate', files: 2, button: 'Arrange all files on one plate and slice together', requestType: 'SLICE_MULTI' },
]) {
  test(`keeps the ${name} config snapshot while files are read`, async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('model-file-input').setInputFiles(
      Array.from({ length: files }, (_, index) => ({
        name: `delayed-${index}.stl`,
        mimeType: 'model/stl',
        buffer: Buffer.alloc(84),
      })),
    )

    await releaseDelayedReads(page)
    await page.getByTestId('tab-slice').click()
    await (button === 'slice-all-button'
      ? page.getByTestId(button)
      : page.getByTitle(button)).click()

    await releaseDelayedReads(page)
    await changeSettingsDuringRead(page)
    await releaseDelayedReads(page)

    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __sliceRequests: Array<{ type: string; config: SliceRequestConfig }> }).__sliceRequests
        .map(({ type, config }) => ({ type, nozzle_temperature: config.nozzle_temperature }))
    )), { timeout: 5_000 }).toEqual([{ type: requestType, nozzle_temperature: 220 }])
    await page.getByTestId('tab-slice').click()
    await expect(page.getByText('Sliced with previous settings')).toBeVisible({ timeout: 5_000 })
  })
}

test('keeps a stepped manual override when the active quality preset is clicked again', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'model.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
  await page.getByTestId('tab-settings').click()

  const skirtLoops = page.getByTestId('setting-skirt_loops')
  await expect(skirtLoops).toHaveValue('1')
  await skirtLoops.press('ArrowDown')
  await expect(skirtLoops).toHaveValue('0')
  await expect(page.getByTestId('override-summary')).toContainText('1 setting changed by you')

  await page.getByRole('button', { name: /Standard\s+0\.2 mm/ }).click()
  await expect(skirtLoops).toHaveValue('0')
  await expect(page.getByTestId('override-summary')).toContainText('1 setting changed by you')

  await page.getByTestId('tab-slice').click()
  await page.getByTestId('slice-all-button').click()
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __sliceRequests: Array<{ config: SliceRequestConfig }> }).__sliceRequests
      .map(({ config }) => config.skirt_loops)
  )), { timeout: 5_000 }).toEqual([0])
})

test('keeps a reset action reachable for an override whose control is hidden', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'model.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
  await page.getByTestId('tab-settings').click()

  await page.getByTestId('setting-enable_support').click()
  await page.getByTestId('setting-support_type').selectOption('tree(auto)')
  await expect(page.getByTestId('revert-support_type')).toBeVisible()

  await page.getByTestId('setting-enable_support').click()
  await expect(page.getByTestId('setting-support_type')).toHaveCount(0)
  await expect(page.getByTestId('revert-support_type')).toBeVisible()

  await page.getByTestId('revert-support_type').click()
  await expect(page.getByTestId('revert-support_type')).toHaveCount(0)
  await expect(page.getByTestId('override-summary')).toContainText('1 setting changed by you')
})

test('clicking the active quality preset drops a print import but keeps manual edits', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'model.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
  await page.getByTestId('tab-settings').click()

  const skirtLoops = page.getByTestId('setting-skirt_loops')
  await skirtLoops.fill('0')
  await skirtLoops.blur()
  await expect(skirtLoops).toHaveValue('0')

  await page.getByTestId('profile-file-input').setInputFiles({
    name: 'print-profile.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ type: 'print', name: 'Print profile', skirt_loops: 3 })),
  })
  await expect(page.getByText(/Profile: Print profile/)).toBeVisible()

  await page.getByRole('button', { name: /Standard\s+0\.2 mm/ }).click()
  await expect(page.getByText(/Profile: Print profile/)).toBeHidden()
  await expect(skirtLoops).toHaveValue('0')
})

test('changing printer or material drops a complete print import', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByTestId('model-file-input').setInputFiles({
    name: 'model.stl',
    mimeType: 'model/stl',
    buffer: Buffer.alloc(84),
  })
  await page.getByTestId('tab-settings').click()

  const printProfile = {
    type: 'print',
    name: 'Complete print context',
    printer_model: 'Generic',
    filament_type: ['PLA'],
    nozzle_temperature: ['215'],
  }
  const importProfile = () => page.getByTestId('profile-file-input').setInputFiles({
    name: 'complete-print.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(printProfile)),
  })

  await importProfile()
  const profileChip = page.getByText(/Profile: Complete print context/)
  await expect(profileChip).toBeVisible()
  await page.locator('select').nth(1).selectOption('PETG')
  await expect(profileChip).toHaveCount(0)

  await importProfile()
  await expect(profileChip).toBeVisible()
  await page.locator('select').nth(0).selectOption('Prusa MK4')
  await expect(profileChip).toHaveCount(0)
})
