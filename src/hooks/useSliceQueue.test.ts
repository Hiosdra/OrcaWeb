import { describe, expect, it } from 'vitest'
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
