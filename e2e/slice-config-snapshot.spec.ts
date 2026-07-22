import { expect, test, type Page } from '@playwright/test'

type SliceRequestConfig = { nozzle_temperature?: number; skirt_loops?: number }

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const originalArrayBuffer = File.prototype.arrayBuffer
    const delayedReads: Array<(buffer: ArrayBuffer) => void> = []

    Object.assign(window, {
      __delayedReads: delayedReads,
      __sliceRequests: [] as Array<{ type: string; config: SliceRequestConfig }>,
    })

    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith('delayed-')) return originalArrayBuffer.call(this)
      return new Promise((resolve) => delayedReads.push(resolve))
    }

    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null

      postMessage(message: { type: string; config?: SliceRequestConfig }) {
        if (message.type === 'LOAD_WASM') {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'WASM_LOADED', engineLabel: 'Test' } } as MessageEvent))
          return
        }

        if (message.type === 'SLICE' || message.type === 'SLICE_MULTI') {
          ;(window as typeof window & { __sliceRequests: unknown[] }).__sliceRequests.push({
            type: message.type,
            config: message.config ?? {},
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
