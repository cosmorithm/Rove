import test from 'node:test'
import assert from 'node:assert/strict'
import { createChat, readLibrary, saveLibrary } from '../library.ts'

const key = 'zhixue-library-v2'

function storage(t, entries = {}) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map(Object.entries(entries))
  const writes = []
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(name) { return values.get(name) ?? null },
    setItem(name, value) { writes.push(name); values.set(name, value) },
  } })
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior)
    else delete globalThis.localStorage
  })
  return { values, writes }
}

function existing() {
  return {
    active: 'pdf-session',
    notes: [{
      id: 'pdf-session', name: '随机过程', label: 'AI 知识点',
      pdfId: 'a'.repeat(64), storage: 'file',
      blocks: [{ id: 'point-7', title: '原题的标题', body: '保留资料内容', page: 4, cards: [{
        id: 'turn-1', question: '为什么？', answer: '原始回答', editedAnswer: '修订回答',
        excerpt: '保留引用', demo: false, children: [{
          id: 'turn-2', question: '另一个分支？', answer: '子回答', excerpt: '', demo: false, children: [],
        }], studyContext: { revision: 'source-revision', title: 'L0 标题', state: 'ready' },
      }] }],
    }],
  }
}

test('a fresh library opens a blank general Chat and persists its IDs before the first question', t => {
  const { values, writes } = storage(t)
  const first = readLibrary()
  assert.equal(first.notes.length, 1)
  const chat = first.notes[0]
  assert.equal(first.active, chat.id)
  assert.equal(chat.kind, 'chat')
  assert.equal(chat.name, '新对话')
  assert.equal(chat.label, '对话')
  assert.equal(chat.pdfId, undefined)
  assert.equal(chat.blocks.length, 1)
  assert.equal(chat.blocks[0].title, '对话起点')
  assert.equal(chat.blocks[0].body, '')
  assert.deepEqual(chat.blocks[0].cards, [])
  assert.notEqual(chat.id, chat.blocks[0].id)
  assert.deepEqual(writes, [key])
  assert.equal(values.has('zhixue-prototype-v1'), false)
  const second = readLibrary()
  assert.deepEqual(second, first, 'reload reuses the same empty conversation and root IDs')
  assert.deepEqual(writes, [key], 'reading saved data does not rewrite it')
})

test('createChat produces independent conversations without changing existing source records', t => {
  storage(t)
  const library = existing()
  const original = structuredClone(library.notes[0])
  const chat = createChat('任意主题')
  const other = createChat('   ')
  assert.equal(chat.name, '任意主题')
  assert.equal(other.name, '新对话')
  assert.notEqual(chat.id, other.id)
  assert.notEqual(chat.blocks[0].id, other.blocks[0].id)
  chat.blocks[0].cards.push({ id: 'new-turn', question: '讨论产品设计', answer: '开始探索', excerpt: '', demo: false, children: [] })
  library.notes.unshift(chat)
  library.active = chat.id
  saveLibrary(library)
  const saved = readLibrary()
  assert.deepEqual(saved, library)
  assert.deepEqual(saved.notes[1], original, 'original PDF/node IDs, versions and references remain intact')
})

test('existing libraries retain their active PDF and all content without injecting a sample', t => {
  const original = existing()
  const raw = JSON.stringify(original)
  const { values, writes } = storage(t, { [key]: raw })
  assert.deepEqual(readLibrary(), original)
  assert.equal(values.get(key), raw)
  assert.deepEqual(writes, [])
  assert.equal(readLibrary().notes.some(note => note.id === 'sample'), false)
})

test('an existing sample or non-PDF note is retained rather than recreated or reclassified', t => {
  const saved = existing()
  saved.notes.push({ id: 'sample', name: '用户保留的示例', label: '示例讲义', blocks: [{ id: 'sample-root', title: '示例', body: '用户内容', cards: [] }] })
  saved.active = 'sample'
  storage(t, { [key]: JSON.stringify(saved) })
  assert.deepEqual(readLibrary(), saved)
  assert.equal(readLibrary().notes.length, 2)
})

test('a missing active ID repairs selection without changing notes or assigning new IDs', t => {
  const saved = existing()
  saved.active = 'removed-note'
  storage(t, { [key]: JSON.stringify(saved) })
  const loaded = readLibrary()
  assert.equal(loaded.active, saved.notes[0].id)
  assert.deepEqual(loaded.notes, saved.notes)
})

test('legacy prototype data migrates without adding a tutor sample or changing source blocks', t => {
  const blocks = existing().notes[0].blocks
  const legacy = { documentName: '旧资料', documentLabel: '已导入', lecture: blocks }
  const raw = JSON.stringify(legacy)
  const { values, writes } = storage(t, { 'zhixue-prototype-v1': raw })
  const loaded = readLibrary()
  assert.deepEqual(loaded, {
    active: 'previous', notes: [{ id: 'previous', name: '旧资料', label: '已导入', blocks }],
  })
  assert.equal(values.get('zhixue-prototype-v1'), raw)
  assert.deepEqual(writes, [])
  saveLibrary(loaded)
  assert.deepEqual(readLibrary(), loaded)
})

test('empty or malformed stored data gets a usable Chat fallback without overwriting the original payload', t => {
  const { values, writes } = storage(t)
  for (const raw of ['{broken', JSON.stringify({ active: '', notes: [] }), JSON.stringify({ notes: [{ id: 'bad', blocks: null }] })]) {
    values.set(key, raw)
    const loaded = readLibrary()
    assert.equal(loaded.notes.length, 1)
    assert.equal(loaded.notes[0].kind, 'chat')
    assert.equal(loaded.notes[0].blocks[0].title, '对话起点')
    assert.equal(values.get(key), raw)
  }
  assert.deepEqual(writes, [])
})

test('unavailable storage still returns a usable empty Chat', t => {
  storage(t)
  globalThis.localStorage.getItem = () => { throw new Error('Storage disabled') }
  const loaded = readLibrary()
  assert.equal(loaded.notes[0].kind, 'chat')
  assert.equal(loaded.active, loaded.notes[0].id)
  assert.deepEqual(loaded.notes[0].blocks[0].cards, [])
})

test('a fresh conversation still works if initial persistence is denied', t => {
  storage(t)
  globalThis.localStorage.setItem = () => { throw new Error('Quota exceeded') }
  assert.equal(readLibrary().notes[0].kind, 'chat')
})
