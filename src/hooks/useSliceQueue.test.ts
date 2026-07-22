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

describe('reassigning a slot while the slice is still running', () => {
  // The request already went out carrying the old assignment, so the result
  // that comes back is outdated the moment the picker changes. A config edit
  // gets this from the configEpoch/sliceStartEpoch comparison, but an
  // assignment never touches configSnapshotRef and so has no epoch — the
  // picker stays enabled throughout (SliceCards hides it only for
  // converting/error), and a plate slice is exactly the multi-second window
  // where this happens.

  it('marks the in-flight single slice stale, so the result is not shown as current', () => {
    const items = [{ id: 'a', name: 'cube.stl', status: 'slicing' }] as unknown as typeof state.items
    let next = sliceQueueReducer(
      { ...state, items, currentId: 'a' },
      { type: 'ASSIGN_EXTRUDER', id: 'a', extruderId: 2 },
    )
    next = sliceQueueReducer(next, { type: 'SLICE_DONE', gcode: 'G1 X0' })
    expect(next.items[0]).toMatchObject({ status: 'done', extruderId: 2, stale: true })
  })

  it('marks the in-flight plate stale, where PLATE_STARTED has already cleared the gcode', () => {
    let next = sliceQueueReducer(state, { type: 'PLATE_STARTED', configEpoch: 0 })
    next = sliceQueueReducer(next, { type: 'ASSIGN_EXTRUDER', id: 'a', extruderId: 2 })
    next = sliceQueueReducer(next, { type: 'PLATE_DONE', gcode: 'G1 X0' })
    expect(next.plate).toMatchObject({ gcode: 'G1 X0', stale: true })
  })

  it('still reports an undisturbed slice as current — the OR must not make everything stale', () => {
    // RUN_QUEUE clears `stale` before re-slicing, so a flag surviving into
    // SLICE_DONE can only have arrived during the run. Without this control a
    // fix that simply always sets stale would pass the two tests above.
    const items = [{ id: 'a', name: 'cube.stl', status: 'slicing' }] as unknown as typeof state.items
    const single = sliceQueueReducer({ ...state, items, currentId: 'a' }, { type: 'SLICE_DONE', gcode: 'G1 X0' })
    expect((single.items[0] as { stale?: boolean }).stale).toBeUndefined()

    let plate = sliceQueueReducer(state, { type: 'PLATE_STARTED', configEpoch: 0 })
    plate = sliceQueueReducer(plate, { type: 'PLATE_DONE', gcode: 'G1 X0' })
    expect(plate.plate.stale).toBe(false)
  })

  it('clears the flag again when the item is re-queued', () => {
    const items = [
      { id: 'a', name: 'cube.stl', status: 'done', gcode: 'G1', stale: true },
    ] as unknown as typeof state.items
    const next = sliceQueueReducer({ ...state, items }, { type: 'RUN_QUEUE' })
    expect(next.items[0]).toMatchObject({ status: 'ready' })
    expect((next.items[0] as { stale?: boolean }).stale).toBeUndefined()
  })
})

describe('filament slots removed from the config', () => {
  const assigned = [
    { id: 'a', status: 'ready', extruderId: 3 },
    { id: 'b', status: 'ready', extruderId: 1 },
  ] as unknown as typeof state.items

  it('drops assignments naming a slot the config no longer has', () => {
    // Below two slots the picker disappears entirely, so a stale assignment is
    // invisible — but buildPlateExtruderIds would still send it and the engine
    // would index its per-filament vectors out of range.
    const next = sliceQueueReducer({ ...state, items: assigned }, { type: 'CONFIG_CHANGED', epoch: 1, slotCount: 2 })
    expect(next.items[0].extruderId).toBeUndefined()
    expect(next.items[1].extruderId).toBe(1)
    expect(buildPlateExtruderIds(next.items)).toEqual([0, 1])
  })

  it('leaves assignments alone when every slot still exists', () => {
    const next = sliceQueueReducer({ ...state, items: assigned }, { type: 'CONFIG_CHANGED', epoch: 1, slotCount: 3 })
    expect(next.items.map((i) => i.extruderId)).toEqual([3, 1])
  })

  it('clears every assignment when the config drops back to one slot', () => {
    const next = sliceQueueReducer({ ...state, items: assigned }, { type: 'CONFIG_CHANGED', epoch: 1, slotCount: 1 })
    expect(buildPlateExtruderIds(next.items)).toBeUndefined()
  })

  it('still marks sliced items stale while dropping the assignment', () => {
    const items = [{ id: 'a', status: 'done', gcode: 'G1', extruderId: 3 }] as unknown as typeof state.items
    const next = sliceQueueReducer({ ...state, items }, { type: 'CONFIG_CHANGED', epoch: 1, slotCount: 1 })
    expect(next.items[0]).toMatchObject({ stale: true })
    expect(next.items[0].extruderId).toBeUndefined()
  })
})
