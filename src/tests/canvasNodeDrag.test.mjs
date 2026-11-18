import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvasNodeDrag } from '../canvasNodeDrag.ts'

function setup(scale = 1) {
  const captures = new Set(), released = [], focused = [], started = [], ended = [], active = [], moved = []
  const positions = { 'q/a': { x: 100, y: 80 }, 'q/b': { x: 400, y: 80 } }
  const transform = { left: 20, top: 30, minX: 0, minY: 0, scale, available: true }
  const handle = {
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => { captures.delete(id); released.push(id) },
    focus: options => focused.push(options),
  }
  const drag = createCanvasNodeDrag({
    position: key => positions[key],
    point: e => transform.available ? { x: (e.clientX - transform.left) / transform.scale + transform.minX,
      y: (e.clientY - transform.top) / transform.scale + transform.minY } : undefined,
    onStart: key => started.push(key),
    onMove: (key, point) => { moved.push({ key, point }); positions[key] = point },
    onEnd: key => ended.push(key), onActive: key => active.push(key),
  })
  const event = (overrides = {}) => ({ pointerId: 1, isPrimary: true, button: 0, buttons: 1,
    pointerType: 'mouse', clientX: 150, clientY: 130, currentTarget: handle, target: { closest: () => null },
    detail: 1, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.propagationStopped = true }, ...overrides })
  return { drag, event, positions, transform, captures, released, focused, started, ended, active, moved }
}

test('a node click captures and focuses without moving, persisting or swallowing the click', () => {
  const { drag, event, positions, started, ended, focused } = setup()
  const down = event()
  drag.start(down, 'q/a')
  assert.equal(drag.active, true)
  assert.equal(down.propagationStopped, true, 'does not also start background panning')
  assert.deepEqual(focused, [{ preventScroll: true }])
  drag.finish(event())
  assert.equal(drag.active, false)
  assert.equal(drag.consumeClick(event(), 'q/a'), false)
  assert.deepEqual(positions['q/a'], { x: 100, y: 80 })
  assert.deepEqual(started, [])
  assert.deepEqual(ended, [])
})

test('small hand movements remain clicks at every zoom level', () => {
  for (const scale of [0.2, 1, 1.8]) {
    const { drag, event, moved, ended } = setup(scale)
    drag.start(event(), 'q/a')
    drag.move(event({ clientX: 153, clientY: 132 }))
    drag.finish(event())
    assert.equal(drag.consumeClick(event(), 'q/a'), false)
    assert.deepEqual(moved, [])
    assert.deepEqual(ended, [])
  }
})

test('dragging moves only the chosen node, preserves its grab offset, and saves once on release', () => {
  const { drag, event, positions, started, ended, active, captures, released } = setup()
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: 210, clientY: 170 }))
  assert.deepEqual(positions['q/a'], { x: 160, y: 120 })
  assert.deepEqual(positions['q/b'], { x: 400, y: 80 })
  assert.deepEqual(started, ['q/a'])
  assert.deepEqual(ended, [], 'pointer moves must not repeatedly write persistent storage')
  drag.move(event({ clientX: 230, clientY: 190 }))
  assert.deepEqual(positions['q/a'], { x: 180, y: 140 })
  assert.deepEqual(started, ['q/a'], 'freezes automatic layout only once per gesture')
  drag.finish(event())
  assert.deepEqual(ended, ['q/a'])
  assert.deepEqual(active, ['q/a', undefined])
  assert.deepEqual(released, [1])
  assert.equal(captures.size, 0)
})

test('screen movement is converted to canvas coordinates at the actual zoom', () => {
  for (const scale of [0.25, 0.5, 1, 1.8]) {
    const { drag, event, positions } = setup(scale)
    drag.start(event(), 'q/a')
    drag.move(event({ clientX: 240, clientY: 175 }))
    assert.ok(Math.abs(positions['q/a'].x - (100 + 90 / scale)) < 1e-8)
    assert.ok(Math.abs(positions['q/a'].y - (80 + 45 / scale)) < 1e-8)
    drag.cancel()
  }
})

test('re-reading the plane transform keeps dragging correct after scrolling or negative-bound expansion', () => {
  const { drag, event, positions, transform } = setup(0.5)
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: 160, clientY: 140 }))
  assert.deepEqual(positions['q/a'], { x: 120, y: 100 })
  // Bounds shift by -100 world units while the viewport compensates by 50 screen pixels.
  transform.minX = -100; transform.minY = -100
  transform.left -= 50; transform.top -= 50
  drag.move(event({ clientX: 170, clientY: 150 }))
  assert.deepEqual(positions['q/a'], { x: 140, y: 120 })
  // A wheel scroll shifts the scene 20 pixels left underneath the captured pointer.
  transform.left -= 20
  drag.move(event({ clientX: 180, clientY: 150 }))
  assert.deepEqual(positions['q/a'], { x: 200, y: 120 })
  drag.cancel()
})

test('a real drag suppresses its synthetic mouse click but not the next ordinary click', () => {
  const { drag, event } = setup()
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: 180 }))
  drag.finish(event())
  const click = event()
  assert.equal(drag.consumeClick(click, 'q/a'), true)
  assert.equal(click.defaultPrevented, true)
  assert.equal(click.propagationStopped, true)
  drag.start(event(), 'q/a')
  drag.finish(event())
  assert.equal(drag.consumeClick(event(), 'q/a'), false)
})

test('keyboard activation is not swallowed when cancellation did not produce a mouse click', () => {
  const { drag, event } = setup()
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: 180 }))
  drag.cancel()
  assert.equal(drag.consumeClick(event({ detail: 0 }), 'q/a'), false)
})

test('another pointer cannot replace, move or terminate an active node drag', () => {
  const { drag, event, positions, started, ended } = setup()
  drag.start(event(), 'q/a')
  const other = event({ pointerId: 2, clientX: 300, clientY: 300 })
  drag.start(other, 'q/b')
  drag.move(other)
  drag.finish(other)
  assert.equal(drag.active, true)
  assert.deepEqual(positions, { 'q/a': { x: 100, y: 80 }, 'q/b': { x: 400, y: 80 } })
  assert.deepEqual(started, [])
  assert.deepEqual(ended, [])
  drag.cancel()
})

test('non-primary presses, right clicks, links and missing nodes keep their original behavior', () => {
  const { drag, event, focused } = setup()
  for (const overrides of [{ isPrimary: false }, { button: 1 }, { button: 2 }, { target: { closest: () => ({}) } }]) {
    const down = event(overrides)
    drag.start(down, 'q/a')
    assert.equal(drag.active, false)
    assert.equal(down.defaultPrevented, false)
  }
  drag.start(event(), 'q/missing')
  assert.equal(drag.active, false)
  assert.deepEqual(focused, [])
})

test('pointer capture allows a node to be dragged outside its initial card and viewport', () => {
  const { drag, event, positions } = setup()
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: -50, clientY: -70 }))
  assert.deepEqual(positions['q/a'], { x: -100, y: -120 })
  drag.finish(event())
  assert.equal(drag.active, false)
})

test('lost capture, blur and repeated cleanup preserve the last position and persist only once', () => {
  const { drag, event, positions, captures, released, ended } = setup()
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: 180 }))
  captures.clear()
  drag.finish(event()) // lostpointercapture or pointercancel
  drag.cancel() // window blur / component deactivation / unmount
  drag.move(event({ clientX: 250 }))
  assert.deepEqual(positions['q/a'], { x: 130, y: 80 })
  assert.deepEqual(ended, ['q/a'])
  assert.deepEqual(released, [])
})

test('a missed pointer release stops subsequent hover movement and saves the completed part of the drag', () => {
  const { drag, event, positions, ended } = setup()
  drag.start(event(), 'q/a')
  drag.move(event({ clientX: 180 }))
  drag.move(event({ buttons: 0, clientX: 300 }))
  assert.equal(drag.active, false)
  assert.deepEqual(positions['q/a'], { x: 130, y: 80 })
  assert.deepEqual(ended, ['q/a'])
})

test('a removed canvas cancels safely instead of writing invalid coordinates', () => {
  const { drag, event, transform, moved, ended } = setup()
  drag.start(event(), 'q/a')
  transform.available = false
  drag.move(event({ clientX: 250 }))
  assert.equal(drag.active, false)
  assert.deepEqual(moved, [])
  assert.deepEqual(ended, [])
})
