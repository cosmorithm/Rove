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
  kind?: 'chat'
  // A legacy import has no content hash until it is reimported.
  pdfId?: string
  storage?: 'file'
}

export interface Library {
  active: string
  notes: StudyNote[]
}

const storageKey = 'zhixue-library-v2'

export function createChat(name = '新对话'): StudyNote {
  return {
    id: crypto.randomUUID(), name: name.trim() || '新对话', label: '对话', kind: 'chat',
    blocks: [{ id: crypto.randomUUID(), title: '对话起点', body: '', cards: [] }],
  }
}

export function readLibrary(): Library {
  let fresh = false
  try {
    const raw = localStorage.getItem(storageKey)
    const saved = JSON.parse(raw || 'null') as Library | null
    if (saved?.notes?.length && saved.notes.every(note => typeof note.id === 'string' && Array.isArray(note.blocks))) {
      if (!saved.notes.some(note => note.id === saved.active)) saved.active = saved.notes[0].id
      return saved
    }
    const legacy = localStorage.getItem('zhixue-prototype-v1')
    const previous = JSON.parse(legacy || 'null')
    if (Array.isArray(previous?.lecture) && previous.lecture.length) {
      const id = 'previous'
      return { active: id, notes: [{id, name: previous.documentName || '上次的讲义', label: previous.documentLabel || '已保存', blocks: previous.lecture}] }
    }
    fresh = raw === null && legacy === null
  } catch { /* Existing data stays untouched if storage is unavailable or malformed. */ }
  const chat = createChat()
  const fallback = { active: chat.id, notes: [chat] }
  if (fresh) {
    // A new empty conversation needs stable IDs even before the first message is sent.
    try { saveLibrary(fallback) } catch { /* It remains usable when local storage is unavailable. */ }
  }
  return fallback
}

export function saveLibrary(library: Library) {
  localStorage.setItem(storageKey, JSON.stringify(library, (key, value) => {
    if (key === 'loading' || key === 'chatBusy') return false
    if (key === 'polishError') return undefined
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
