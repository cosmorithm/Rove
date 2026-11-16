import test from 'node:test'
import assert from 'node:assert/strict'
import { applyAppearance, defaultAppearance, readAppearance, saveAppearance, themePresets } from '../appearance.ts'

const selected = () => ({ theme: 'blue', fontSize: 17, fontStyle: 'serif', contrast: 'standard', weight: 550 })

test('appearance preferences round-trip independently of unrelated stored values', () => {
  const values = new Map([['other-setting', 'keep']])
  const store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  assert.equal(saveAppearance(selected(), store), true)
  assert.deepEqual(readAppearance(store), selected())
  assert.equal(values.get('other-setting'), 'keep')
})

test('missing, corrupt, unavailable and wrong-shaped storage use readable defaults', () => {
  for (const value of [null, '', 'broken', 'null', '[]', '42', '"string"']) {
    assert.deepEqual(readAppearance({ getItem: () => value }), defaultAppearance)
  }
  assert.deepEqual(readAppearance({ getItem: () => { throw new Error('unavailable') } }), defaultAppearance)
  assert.equal(saveAppearance(selected(), { setItem: () => { throw new Error('quota') } }), false)
  assert.deepEqual(readAppearance(), defaultAppearance)
})

test('valid fields survive partial or older preferences and invalid CSS values are discarded', () => {
  const input = { theme: 'sage', fontSize: 999, fontStyle: 'url(unsafe)', contrast: 'strong', weight: 'bold', extra: 'ignored' }
  assert.deepEqual(readAppearance({ getItem: () => JSON.stringify(input) }), {
    theme: 'sage', fontSize: 15, fontStyle: 'system', contrast: 'strong', weight: 450,
  })
  const a = readAppearance({ getItem: () => null })
  a.theme = 'paper'
  assert.equal(defaultAppearance.theme, 'lavender')
  assert.equal(readAppearance({ getItem: () => null }).theme, 'lavender')
})

test('applying appearance updates exactly the documented root attributes and variables', () => {
  const attributes = new Map(), variables = new Map()
  const element = { setAttribute: (name, value) => attributes.set(name, value),
    style: { setProperty: (name, value) => variables.set(name, value) } }
  applyAppearance(selected(), element)
  assert.deepEqual(Object.fromEntries(attributes), {
    'data-rove-theme': 'blue', 'data-rove-contrast': 'standard', 'data-rove-font': 'serif',
  })
  assert.deepEqual(Object.fromEntries(variables), {
    '--rove-font-scale': String(17 / 14), '--rove-font-weight': '550',
  })
  applyAppearance({ ...selected(), theme: 'bad', fontSize: 0, weight: 'bold' }, element)
  assert.equal(attributes.get('data-rove-theme'), 'lavender')
  assert.equal(variables.get('--rove-font-scale'), String(15 / 14))
  assert.equal(variables.get('--rove-font-weight'), '450')
  assert.doesNotThrow(() => applyAppearance(selected()))
})

test('theme choices expose the supported palettes without remote resources', () => {
  assert.deepEqual(themePresets.map(item => item.id), ['lavender', 'paper', 'blue', 'sage'])
  assert.ok(themePresets.every(item => item.name && /^#[0-9a-f]{6}$/i.test(item.swatch)))
})
