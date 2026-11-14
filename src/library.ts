import type { Card } from './types'

export interface Block {
  id: string
  title: string
  body: string
  page?: number
  cards: Card[]
}

export interface StudyNote {
  id: string
  name: string
  label: string
  blocks: Block[]
  // A legacy import has no content hash until it is reimported.
  pdfId?: string
  storage?: 'file'
}

export interface Library {
  active: string
  notes: StudyNote[]
}

const storageKey = 'zhixue-library-v2'

function sample(): StudyNote {
  return {
    id: 'sample', name: '从斜率理解梯度下降', label: '示例讲义',
    blocks: [
      { id: 'sample-1', title: '为什么要沿着负梯度走？', body: '想象你正在山坡上找最低点。梯度指向当前位置上升最快的方向，负梯度指向相反方向。沿负梯度迈出足够小的一步，通常会使函数值下降。', cards: [] },
      { id: 'sample-2', title: '一步应该迈多远？', body: '以损失函数 L(w) = w² 为例，在 w = 3 时，导数是 6。若学习率为 0.1，一步更新后 w = 3 − 0.1 × 6 = 2.4，损失从 9 降到 5.76。把学习率换成 2，再算一次，看看损失怎么变。', cards: [] },
    ],
  }
}

export function readLibrary(): Library {
  const example = sample()
  const fallback = { active: example.id, notes: [example] }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as Library | null
    if (saved?.notes?.length && saved.notes.every(note => typeof note.id === 'string' && Array.isArray(note.blocks))) {
      if (!saved.notes.some(note => note.id === 'sample')) saved.notes.push(example)
      if (!saved.notes.some(note => note.id === saved.active)) saved.active = saved.notes[0].id
      return saved
    }
    const previous = JSON.parse(localStorage.getItem('zhixue-prototype-v1') || 'null')
    if (Array.isArray(previous?.lecture) && previous.lecture.length) {
      const id = 'previous'
      return { active: id, notes: [{id, name: previous.documentName || '上次的讲义', label: previous.documentLabel || '已保存', blocks: previous.lecture}, example] }
    }
  } catch { /* The new session can still be used if storage is unavailable. */ }
  return fallback
}

export function saveLibrary(library: Library) {
  localStorage.setItem(storageKey, JSON.stringify(library, (key, value) => {
    if (key === 'loading') return false
    if (key === 'cards' || key === 'children') {
      return Array.isArray(value) ? value.map((card: Card) => card.loading ? { ...card, answer: '上次回答已中断，可以继续追问。', loading: false } : card) : value
    }
    return value
  }))
}

let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zhixu-source-files', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('pdfs')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch((error) => { database = undefined; throw error })
  }
  return database
}

export async function storePdf(id: string, data: string) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('pdfs', 'readwrite')
    tx.objectStore('pdfs').put(data, id)
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error)
  })
}

export async function loadPdf(id: string) {
  const db = await openDatabase()
  return new Promise<string | undefined>((resolve, reject) => {
    const request = db.transaction('pdfs').objectStore('pdfs').get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
