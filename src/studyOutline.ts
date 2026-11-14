import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'

export interface StudyOutlineItem {
  title: string
  page: number
}

// Preserve Chinese punctuation while normalizing compatibility radicals in subset fonts.
function titleText(text: string) {
  return text.replace(/[\u2e80-\u2fff\uf900-\ufaff]/gu, char => char.normalize('NFKC'))
    .replace(/[\u200b\u00ad]/g, '').replace(/\s+/g, ' ').trim()
}

async function bookmarks(doc: PDFDocumentProxy): Promise<StudyOutlineItem[]> {
  const roots = await doc.getOutline()
  if (!roots?.length) return []
  const pending = [...roots].reverse()
  const result: StudyOutlineItem[] = []
  const seen = new Set<string>()
  while (pending.length) {
    const node = pending.pop()!
    for (let i = node.items.length - 1; i >= 0; i--) pending.push(node.items[i])
    const title = titleText(node.title)
    if (!title || !node.dest) continue
    try {
      const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest
      if (!dest?.length) continue
      const ref = dest[0]
      const index = Number.isInteger(ref) ? ref : await doc.getPageIndex(ref)
      const page = index + 1
      const key = `${page}/${title}`
      if (Number.isInteger(page) && page >= 1 && page <= doc.numPages && !seen.has(key)) {
        result.push({ title, page })
        seen.add(key)
      }
    } catch { /* A broken destination does not invalidate its siblings. */ }
  }
  return result
}

const chineseNumber = '[0-9０-９〇零一二三四五六七八九十百千两]+'
const heading = new RegExp(
  `^(?:第\\s*${chineseNumber}\\s*[题章节讲]|(?:习题|例题)\\s*${chineseNumber}|(?:problem|exercise|question|chapter|section)\\s+\\d+(?:\\.\\d+)*)(?:\\s*[:：.．、—–-]\\s*|\\s+|$)`,
  'iu',
)

function pageHeadings(content: TextContent): string[] {
  const items = content.items.filter((item): item is TextItem => 'str' in item && item.str.trim() !== '' && item.height > 0)
  if (!items.length) return []
  const fontSizes = items.map(item => item.height).sort((a, b) => a - b)
  const bodySize = fontSizes[Math.floor(fontSizes.length / 2)]
  const lines: { text: string; size: number }[] = []
  // PDF generators can emit math runs after the surrounding heading has ended.
  // Reassemble runs at their printed positions so those symbols stay in the title.
  items.sort((a, b) => b.transform[5] - a.transform[5])
  let row: TextItem[] = []
  function finishRow() {
    if (!row.length) return
    row.sort((a, b) => a.transform[4] - b.transform[4])
    let text = '', size = 0, right = 0
    for (const item of row) {
      const gap = item.transform[4] - right
      const em = Math.max(size, item.height)
      if (text && gap > em * 2.5) {
        lines.push({ text: titleText(text), size })
        text = ''
        size = 0
      }
      if (text && gap > em * 0.12) text += ' '
      text += item.str
      size = Math.max(size, item.height)
      right = item.transform[4] + item.width
    }
    lines.push({ text: titleText(text), size })
    row = []
  }
  for (const item of items) {
    if (row.length && row[0].transform[5] - item.transform[5] > Math.max(1, bodySize * 0.15)) finishRow()
    row.push(item)
  }
  finishRow()
  return lines.filter(line => line.size >= bodySize * 1.12 && line.text.length <= 180 && heading.test(line.text))
    .map(line => line.text)
}

export async function readStudyOutline(doc: PDFDocumentProxy): Promise<StudyOutlineItem[]> {
  const outline = await bookmarks(doc).catch(() => [])
  if (outline.length) return outline
  // Text extraction is a fallback for short handouts. Leave long unbookmarked books unindexed.
  if (doc.numPages > 48) return []
  const result: StudyOutlineItem[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= doc.numPages; page++) {
    try {
      const proxy = await doc.getPage(page)
      const content = await proxy.getTextContent()
      for (const title of pageHeadings(content)) {
        if (!seen.has(title)) result.push({ title, page })
        seen.add(title)
      }
    } catch { /* Keep results from pages whose text can be read. */ }
  }
  return result
}
