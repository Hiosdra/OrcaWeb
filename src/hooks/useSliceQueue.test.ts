import { describe, expect, it } from 'vitest'
import type { QueueItem } from '../types'
import { sliceQueueReducer } from './useSliceQueue'

const state = {
  items: [],
  currentId: null,
  running: false,
  plate: { slicing: false, gcode: null, error: null, stale: false },
  configEpoch: 0,
  sliceStartEpoch: 0,
  plateStartEpoch: 0,
}

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const sourceFile = new File(['x'], 'part.stl')
  return {
    id: 'item-1',
    name: 'part.stl',
    originalSize: 1,
    sourceFile,
    stlFile: sourceFile,
    status: 'ready',
    ...overrides,
  }
}

describe('slice queue mutual exclusion', () => {
  it('does not start a plate while single-file work is active', () => {
    expect(
      sliceQueueReducer({ ...state, currentId: 'item-1', running: true }, { type: 'PLATE_STARTED', configEpoch: 0 }),
    ).toEqual({ ...state, currentId: 'item-1', running: true })
  })

  it('does not start the single-file queue while a plate is slicing', () => {
    const plate = { ...state.plate, slicing: true }
    expect(sliceQueueReducer({ ...state, plate }, { type: 'RUN_QUEUE' })).toEqual({ ...state, plate })
  })

  it('CANCELLED resets plate.slicing even with no currentId set — the path removeItem() relies on to abort an in-flight plate slice', () => {
    const plate = { ...state.plate, slicing: true }
    expect(sliceQueueReducer({ ...state, plate }, { type: 'CANCELLED' })).toEqual({
      ...state,
      plate: { ...plate, slicing: false, progress: undefined },
    })
  })
})

describe('CONFIG_CHANGED extruder-slot clamping', () => {
  it("clears an item's extruderId when it no longer fits the new filament_type slot count", () => {
    const items = [makeItem({ extruderId: 3 })]
    const result = sliceQueueReducer({ ...state, items }, { type: 'CONFIG_CHANGED', epoch: 1, maxFilamentSlot: 1 })
    expect(result.items[0].extruderId).toBeUndefined()
  })

  it('leaves a still-valid extruderId untouched', () => {
    const items = [makeItem({ extruderId: 2 })]
    const result = sliceQueueReducer({ ...state, items }, { type: 'CONFIG_CHANGED', epoch: 1, maxFilamentSlot: 4 })
    expect(result.items[0].extruderId).toBe(2)
  })
})
