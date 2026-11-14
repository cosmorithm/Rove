import type { PDFPageProxy } from 'pdfjs-dist'

// Some Chinese PDFs map ordinary Han glyphs to Kangxi radicals. Restrict normalization
// to that block so superscripts, mathematical alphabets and other notation stay intact.
const radicalForms: Record<string, string> = { '⻚': '页', '⻆': '角', '⻓': '长' }
export function normalizePdfText(text: string) {
  return text.replace(/[\u2f00-\u2fd5⻚⻆⻓]/gu, glyph => radicalForms[glyph] ?? glyph.normalize('NFKC')).trim()
}

export async function readPageText(page: PDFPageProxy, signal: AbortSignal, limit = Infinity) {
  signal.throwIfAborted()
  const reader = page.streamTextContent().getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let text = ''
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      for (const item of value.items) {
        if (!('str' in item)) continue
        // Real word gaps already appear in item.str. Inserting a gap at every font
        // fragment would separate each Chinese glyph and split mathematical tokens.
        text += (item.str + (item.hasEOL ? '\n' : '')).slice(0, limit - text.length)
        if (text.length >= limit) break
      }
    }
    return normalizePdfText(text)
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
