import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const originalArrayBuffer = File.prototype.arrayBuffer
    const delayedReads: Array<(buffer: ArrayBuffer) => void> = []

    Object.assign(window, {
      __delayedReads: delayedReads,
      __sliceRequests: [] as Array<{ type: string; config: { nozzle_temperature?: number } }>,
    })

    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith('delayed-')) return originalArrayBuffer.call(this)
      return new Promise((resolve) => delayedReads.push(resolve))
    }

    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null

      postMessage(message: { type: string; config?: { nozzle_temperature?: number } }) {
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
  const nozzleTemp = page.getByText('Nozzle temp', { exact: true }).locator('..').locator('input')
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
      (window as typeof window & { __sliceRequests: Array<{ type: string; config: { nozzle_temperature?: number } }> }).__sliceRequests
        .map(({ type, config }) => ({ type, nozzle_temperature: config.nozzle_temperature }))
    )), { timeout: 5_000 }).toEqual([{ type: requestType, nozzle_temperature: 220 }])
    await page.getByTestId('tab-slice').click()
    await expect(page.getByText('Sliced with previous settings')).toBeVisible({ timeout: 5_000 })
  })
}
