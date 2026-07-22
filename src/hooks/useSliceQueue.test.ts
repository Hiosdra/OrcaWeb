import { describe, expect, it } from 'vitest'
import { buildPlateExtruderIds, sliceQueueReducer } from './useSliceQueue'

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

describe('per-object filament-slot assignment', () => {
  it('omits extruderIds when nothing is assigned (single-material plate)', () => {
    expect(buildPlateExtruderIds([{}, {}, {}])).toBeUndefined()
    expect(buildPlateExtruderIds([{ extruderId: 0 }, {}])).toBeUndefined()
  })

  it('emits a parallel array once any object is assigned, defaulting others to 0', () => {
    expect(buildPlateExtruderIds([{ extruderId: 2 }, {}, { extruderId: 1 }])).toEqual([2, 0, 1])
  })

  it('marks a sliced item stale when its own slot is reassigned', () => {
    const items = [{ id: 'a', status: 'done', gcode: 'G1' }] as unknown as typeof state.items
    const next = sliceQueueReducer({ ...state, items }, { type: 'ASSIGN_EXTRUDER', id: 'a', extruderId: 2 })
    expect(next.items[0]).toMatchObject({ extruderId: 2, stale: true })
  })

  it('does not invent staleness for an item that was never sliced', () => {
    const items = [{ id: 'a', status: 'ready' }] as unknown as typeof state.items
    const next = sliceQueueReducer({ ...state, items }, { type: 'ASSIGN_EXTRUDER', id: 'a', extruderId: 2 })
    expect(next.items[0]).toMatchObject({ extruderId: 2 })
    expect((next.items[0] as { stale?: boolean }).stale).toBeUndefined()
  })

  it('marks an existing plate result stale when a slot is reassigned', () => {
    const plate = { ...state.plate, gcode: 'G1 X0', stale: false }
    const next = sliceQueueReducer({ ...state, plate }, { type: 'ASSIGN_EXTRUDER', id: 'a', extruderId: 2 })
    expect(next.plate.stale).toBe(true)
  })

  it('leaves an empty plate untouched when a slot is reassigned', () => {
    const next = sliceQueueReducer(state, { type: 'ASSIGN_EXTRUDER', id: 'a', extruderId: 2 })
    expect(next.plate).toEqual(state.plate)
  })
})
