import test from 'node:test'
import assert from 'node:assert/strict'
import { clampCanvasPoint, readCanvasPositions, resolveCanvasLayout, saveCanvasPositions } from '../canvasLayout.ts'

const nodes = () => [
  { key: 'b/topic', x: 40, y: 100, width: 190, height: 90 },
  { key: 'q/parent', parentKey: 'b/topic', x: 286, y: 100, width: 244, height: 124 },
  { key: 'q/child', parentKey: 'q/parent', x: 586, y: 40, width: 244, height: 124 },
  { key: 'q/sibling', parentKey: 'b/topic', x: 286, y: 220, width: 244, height: 124 },
]
const numbers = path => path.match(/-?\d+(?:\.\d+)?/g).map(Number)

function storage() {
  const values = new Map([['unrelated', 'keep']])
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('an unsaved map keeps automatic positions and derives edges without changing source nodes', () => {
  const input = nodes(), before = JSON.stringify(input)
  const layout = resolveCanvasLayout(input, {})
  assert.deepEqual(layout.positions['q/parent'], { x: 286, y: 100 })
  assert.deepEqual([layout.minX, layout.minY, layout.width, layout.height], [0, 0, 870, 384])
  assert.equal(layout.links.length, 3)
  const edge = numbers(layout.links.find(link => link.child === 'q/parent').path)
  assert.deepEqual(edge.slice(0, 2), [230, 145])
  assert.deepEqual(edge.slice(-2), [286, 162])
  assert.equal(JSON.stringify(input), before)
})

test('moving a frozen parent changes only that node and its incident edges, not its child or siblings', () => {
  const automatic = resolveCanvasLayout(nodes(), {})
  const frozen = structuredClone(automatic.positions)
  frozen['q/parent'] = { x: 360, y: 180 }
  const moved = resolveCanvasLayout(nodes(), frozen)
  for (const key of ['b/topic', 'q/child', 'q/sibling']) assert.deepEqual(moved.positions[key], automatic.positions[key])
  assert.deepEqual(moved.positions['q/parent'], { x: 360, y: 180 })
  for (const key of ['q/parent', 'q/child']) {
    assert.notEqual(moved.links.find(link => link.child === key).path, automatic.links.find(link => link.child === key).path)
  }
  assert.equal(moved.links.find(link => link.child === 'q/sibling').path, automatic.links.find(link => link.child === 'q/sibling').path)
  assert.deepEqual(frozen['q/child'], automatic.positions['q/child'])
})

test('negative positions expand bounds and every edge endpoint uses the same shifted coordinates as its nodes', () => {
  const frozen = resolveCanvasLayout(nodes(), {}).positions
  frozen['q/parent'] = { x: -300, y: -180 }
  const layout = resolveCanvasLayout(nodes(), frozen)
  assert.equal(layout.minX, -340)
  assert.equal(layout.minY, -220)
  const edge = numbers(layout.links.find(link => link.child === 'q/parent').path)
  assert.deepEqual(edge.slice(0, 2), [380, 365]) // Left face of the topic, relative to bounds.
  assert.deepEqual(edge.slice(-2), [284, 102]) // Right face of a node moved to the left.
  for (const node of nodes()) {
    const point = layout.positions[node.key]
    assert.ok(point.x - layout.minX >= 0 && point.y - layout.minY >= 0)
    assert.ok(point.x - layout.minX + node.width <= layout.width)
    assert.ok(point.y - layout.minY + node.height <= layout.height)
  }
})

test('new descendants are placed near the actual saved parent while existing nodes retain exact positions', () => {
  const input = nodes(), frozen = resolveCanvasLayout(input, {}).positions
  frozen['q/parent'] = { x: 800, y: 600 }
  input.push({ key: 'q/new', parentKey: 'q/parent', x: 586, y: 400, width: 244, height: 124 })
  input.push({ key: 'q/new-child', parentKey: 'q/new', x: 886, y: 400, width: 244, height: 124 })
  const layout = resolveCanvasLayout(input, frozen)
  assert.deepEqual(layout.positions['q/child'], { x: 586, y: 40 })
  assert.deepEqual(layout.positions['q/new'], { x: 1100, y: 900 })
  assert.deepEqual(layout.positions['q/new-child'], { x: 1400, y: 900 })
})

test('orphaned saved positions cannot enlarge the current map or resurrect deleted nodes', () => {
  const baseline = resolveCanvasLayout(nodes(), {})
  const layout = resolveCanvasLayout(nodes(), { 'q/deleted': { x: -9000, y: 9000 } })
  assert.deepEqual(layout, baseline)
  assert.deepEqual(resolveCanvasLayout([], {}), { positions: {}, links: [], minX: 0, minY: 0, width: 0, height: 0 })
})

test('layouts round-trip by stable conversation or project ID without touching conversation content', () => {
  const store = storage()
  const first = { 'b/topic': { x: -100.25, y: 30 }, 'q/parent': { x: 600, y: 420.5 } }
  const second = { 'b/topic': { x: 25, y: 80 } }
  assert.equal(saveCanvasPositions('chat:same-id', first, store), true)
  assert.equal(saveCanvasPositions('chat:other-id', second, store), true)
  assert.equal(saveCanvasPositions('coding:same-id', second, store), true)
  assert.deepEqual(readCanvasPositions('chat:same-id', store), first)
  assert.deepEqual(readCanvasPositions('chat:other-id', store), second)
  assert.deepEqual(readCanvasPositions('coding:same-id', store), second)
  assert.deepEqual(readCanvasPositions('chat:missing-id', store), {})
  assert.equal(store.values.get('unrelated'), 'keep')
  assert.equal(store.values.has('zhixue-library-v2'), false)
  assert.equal(store.values.has('rove-coding-v1'), false)
})

test('resetting one layout preserves every other map and does not depend on display names', () => {
  const store = storage(), saved = { 'q/node': { x: 2, y: 3 } }
  saveCanvasPositions('chat:a', saved, store)
  saveCanvasPositions('chat:b', saved, store)
  saveCanvasPositions('chat:a', {}, store)
  assert.deepEqual(readCanvasPositions('chat:a', store), {})
  assert.deepEqual(readCanvasPositions('chat:b', store), saved)
})

test('missing, corrupt, unsupported or wrong-shaped storage falls back to automatic layout without a write', () => {
  for (const value of [null, '', 'broken', 'null', '[]', '42', '{"version":2,"positions":{}}', '{"version":1,"positions":[]}']) {
    assert.deepEqual(readCanvasPositions('chat:a', { getItem: () => value }), {})
  }
  assert.deepEqual(readCanvasPositions('chat:a', { getItem: () => { throw new Error('denied') } }), {})
  assert.equal(saveCanvasPositions('chat:a', {}, { setItem: () => { throw new Error('quota') } }), false)
})

test('only finite, bounded coordinates of real map-node keys enter persistent layout', () => {
  const store = storage()
  const input = { 'q/good': { x: -5.25, y: 6, answer: 'not layout data' }, 'b/root': { x: 0, y: 0 },
    'q/nan': { x: NaN, y: 1 }, 'q/huge': { x: 1e100, y: 0 }, 'q/string': { x: '3', y: 4 },
    'q/partial': { x: 3 }, 'q/null': null, 'q/array': [1, 2], unrelated: { x: 1, y: 2 } }
  saveCanvasPositions('chat:a', input, store)
  const expected = { 'q/good': { x: -5.25, y: 6 }, 'b/root': { x: 0, y: 0 } }
  assert.deepEqual(readCanvasPositions('chat:a', store), expected)
  const raw = JSON.parse([...store.values.entries()].find(([key]) => key.startsWith('rove-map-layout-v1:'))[1])
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.positions, expected)
})

test('resolved points and storage results are detached copies, not aliases into source metadata', () => {
  const saved = { 'q/parent': { x: 300, y: 200 } }
  const layout = resolveCanvasLayout(nodes(), saved)
  layout.positions['q/parent'].x = 999
  assert.equal(saved['q/parent'].x, 300)
  const store = storage()
  saveCanvasPositions('chat:a', saved, store)
  const read = readCanvasPositions('chat:a', store)
  read['q/parent'].x = 0
  assert.equal(readCanvasPositions('chat:a', store)['q/parent'].x, 300)
})

test('coordinate limits keep extreme pointer positions renderable without forbidding negative movement', () => {
  assert.deepEqual(clampCanvasPoint({ x: -12.5, y: 20.5 }), { x: -12.5, y: 20.5 })
  const point = clampCanvasPoint({ x: -Infinity, y: Infinity })
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  assert.ok(point.x < -100000 && point.y > 100000)
})
