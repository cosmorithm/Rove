import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvasPan } from '../canvasPan.ts'

function setup() {
  const captures = new Set(), states = [], released = []
  const view = {
    scrollLeft: 400, scrollTop: 300,
    clientLeft: 1, clientTop: 1, clientWidth: 600, clientHeight: 400,
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => { captures.delete(id); released.push(id) },
  }
  const pan = createCanvasPan(active => states.push(active))
  const event = (overrides = {}) => ({
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
    clientX: 150, clientY: 160, currentTarget: view, target: { closest: () => null },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    ...overrides,
  })
  return { pan, view, event, states, captures, released }
}

test('dragging blank space scrolls the viewport in both axes with a captured pointer', () => {
  const { pan, view, event, states, captures, released } = setup()
  const down = event()
  pan.start(down)
  assert.equal(down.defaultPrevented, true)
  assert.ok(captures.has(1))
  assert.deepEqual(states, [true])
  const move = event({ clientX: 210, clientY: 120 })
  pan.move(move)
  assert.deepEqual([view.scrollLeft, view.scrollTop], [340, 340])
  assert.equal(move.defaultPrevented, true)
  pan.move(event({ clientX: 100, clientY: 210 }))
  assert.deepEqual([view.scrollLeft, view.scrollTop], [450, 250], 'uses the initial scroll position, not accumulated deltas')
  pan.finish(event())
  assert.deepEqual(states, [true, false])
  assert.deepEqual(released, [1])
})

test('pressing a node or another interactive descendant leaves clicks untouched', () => {
  const { pan, event, states, captures } = setup()
  for (const tag of ['button', 'a', 'input', 'textarea', 'select', '[contenteditable]']) {
    const down = event({ target: { closest: selector => {
      assert.ok(selector.includes(tag))
      return {}
    } } })
    pan.start(down)
    assert.equal(down.defaultPrevented, false)
  }
  assert.deepEqual(states, [])
  assert.equal(captures.size, 0)
})

test('only the primary left mouse or pen press starts panning; touch keeps native scrolling', () => {
  const { pan, event, states } = setup()
  for (const overrides of [{ button: 1 }, { button: 2 }, { isPrimary: false }, { pointerType: 'touch' }]) {
    const down = event(overrides)
    pan.start(down)
    assert.equal(down.defaultPrevented, false)
  }
  assert.deepEqual(states, [])
  pan.start(event({ pointerType: 'pen' }))
  assert.deepEqual(states, [true])
  pan.cancel()
})

test('native scrollbar and border presses are not captured', () => {
  const { pan, event, states } = setup()
  for (const coordinates of [{ clientX: 621 }, { clientY: 431 }, { clientX: 20 }, { clientY: 30 }]) {
    const down = event(coordinates)
    pan.start(down)
    assert.equal(down.defaultPrevented, false)
  }
  assert.deepEqual(states, [])
})

test('a second pointer cannot move, replace or stop the active drag', () => {
  const { pan, view, event, states, captures } = setup()
  pan.start(event())
  const other = event({ pointerId: 2, clientX: 250, clientY: 260 })
  pan.start(other)
  pan.move(other)
  pan.finish(other)
  assert.equal(other.defaultPrevented, false)
  assert.deepEqual([view.scrollLeft, view.scrollTop], [400, 300])
  assert.deepEqual(states, [true])
  assert.deepEqual([...captures], [1])
  pan.cancel()
})

test('capture allows dragging outside the viewport and cancellation stops further updates', () => {
  const { pan, view, event, states } = setup()
  pan.start(event())
  pan.move(event({ clientX: -50, clientY: -40 }))
  assert.deepEqual([view.scrollLeft, view.scrollTop], [600, 500])
  pan.finish(event()) // pointerup and pointercancel share this cleanup.
  pan.move(event({ clientX: 300, clientY: 300 }))
  assert.deepEqual([view.scrollLeft, view.scrollTop], [600, 500])
  assert.deepEqual(states, [true, false])
})

test('lost pointer capture cleans up without releasing capture a second time', () => {
  const { pan, event, states, captures, released } = setup()
  pan.start(event())
  captures.clear()
  pan.finish(event())
  pan.cancel()
  assert.deepEqual(states, [true, false])
  assert.deepEqual(released, [])
})

test('a missed mouse release ends the drag instead of moving the map on hover', () => {
  const { pan, view, event, states, captures } = setup()
  pan.start(event())
  const hover = event({ buttons: 0, clientX: 300, clientY: 300 })
  pan.move(hover)
  assert.deepEqual([view.scrollLeft, view.scrollTop], [400, 300])
  assert.equal(hover.defaultPrevented, false)
  assert.deepEqual(states, [true, false])
  assert.equal(captures.size, 0)
})

test('explicit cleanup is idempotent and the next drag uses its own starting point', () => {
  const { pan, view, event, states } = setup()
  pan.start(event())
  pan.cancel() // Used on blur, deactivation and unmount.
  pan.cancel()
  view.scrollLeft = 800; view.scrollTop = 600
  pan.start(event({ pointerId: 3, clientX: 200, clientY: 200 }))
  pan.move(event({ pointerId: 3, clientX: 220, clientY: 250 }))
  assert.deepEqual([view.scrollLeft, view.scrollTop], [780, 550])
  pan.finish(event({ pointerId: 3 }))
  assert.deepEqual(states, [true, false, true, false])
})
