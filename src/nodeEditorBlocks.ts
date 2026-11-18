type BlockKind = 'paragraph' | 'heading' | 'quote' | 'list' | 'code' | 'display' | 'indented'
const listMarker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/
const quoteMarker = /^ {0,3}>[ \t]?/
const codeFence = /^ {0,3}(`{3,}|~{3,})(.*)$/

function kindOf(line: string): BlockKind {
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return 'heading'
  if (quoteMarker.test(line)) return 'quote'
  if (listMarker.test(line)) return 'list'
  if (codeFence.test(line)) return 'code'
  if (/^ {0,3}(?:\$\$|\\\[)/.test(line)) return 'display'
  if (/^(?: {4}| {0,3}\t)/.test(line)) return 'indented'
  return 'paragraph'
}

/** Keep separators in the preceding block. The raw slices are the source of truth
 * for revisions, including unusual whitespace, CRLF and unclosed code fences. */
export function splitEditorBlocks(source: string): string[] {
  const blocks: string[] = []
  let start = 0
  let kind: BlockKind | undefined
  let blank = false
  let finished = false
  let fence = ''
  let mathEnd = ''
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|[\r\n])|[^\r\n]+$/g)) {
    const line = match[0].replace(/(?:\r\n|[\r\n])$/, '')
    if (!fence && !mathEnd && !line.trim()) { blank = true; continue }
    const next = kindOf(line)
    const insideList = kind === 'list' && (next === 'list' || /^[ \t]/.test(line))
    const insideQuote = kind === 'quote' && next === 'quote'
    const insideCode = kind === 'indented' && next === 'indented'
    const newBlock = finished || (blank && !insideList && !insideQuote && !insideCode) ||
      (!insideList && !insideQuote && next !== kind && ['heading', 'list', 'quote', 'code', 'display'].includes(next))
    if (kind && newBlock && !fence && !mathEnd) {
      blocks.push(source.slice(start, match.index))
      start = match.index
      kind = undefined
    }
    kind ??= next
    blank = false
    finished = false
    // Strip only container syntax for delimiter detection. The returned text is untouched.
    let content = line
    if (kind === 'list') content = line.replace(listMarker, '').trimStart()
    if (kind === 'quote') content = line.replace(/^(?: {0,3}>[ \t]?)+/, '')
    if (fence) {
      const close = content.trim()
      if (close.length >= fence.length && [...close].every(char => char === fence[0])) {
        fence = ''
        finished = kind === 'code'
      }
      continue
    }
    if (mathEnd) {
      if (content.trimEnd().endsWith(mathEnd)) { mathEnd = ''; finished = kind === 'display' }
      continue
    }
    if (kind === 'indented') continue
    const opening = content.match(codeFence)
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = opening[1]
      continue
    }
    const display = content.match(/^ {0,3}(\$\$|\\\[)/)
    if (display) {
      const close = display[1] === '$$' ? '$$' : '\\]'
      if (!content.slice(display[0].length).trimEnd().endsWith(close)) mathEnd = close
      else finished = kind === 'display'
      continue
    }
    finished = kind === 'heading'
  }
  blocks.push(source.slice(start))
  return blocks
}

export function editorBlockText(raw: string): { body: string; tail: string } {
  let end = raw.length
  for (let i = end - 1; i >= 0; i--) {
    const char = raw[i]
    if (char === '\r' || char === '\n') end = i
    else if (char !== ' ' && char !== '\t') break
  }
  return { body: raw.slice(0, end), tail: raw.slice(end) }
}

/** DOM selections use UTF-16 offsets, the same unit as String.slice. */
export function formatEditorSelection(text: string, start: number, end: number, kind: 'bold' | 'italic' | 'code') {
  start = Math.max(0, Math.min(text.length, start))
  end = Math.max(start, Math.min(text.length, end))
  const selected = text.slice(start, end)
  let marker = kind === 'bold' ? '**' : '*'
  let padding = ''
  if (kind === 'code') {
    let width = 1
    for (const run of selected.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1)
    marker = '`'.repeat(width)
    if (/^`|`$/.test(selected) || /^ [\s\S]* $/.test(selected) && selected.trim()) padding = ' '
  }
  const left = marker + padding, right = padding + marker
  let wrapped = text.slice(0, start).endsWith(left) && text.slice(end).startsWith(right)
  if (wrapped && kind === 'italic') {
    // A pair of asterisks marks bold; add italic without stripping half the pair.
    let before = start, after = end
    while (before > 0 && text[before - 1] === '*') before--
    while (text[after] === '*') after++
    wrapped = (start - before) % 2 === 1 && (after - end) % 2 === 1
  }
  if (wrapped) {
    return { text: text.slice(0, start - left.length) + selected + text.slice(end + right.length),
      start: start - left.length, end: end - left.length }
  }
  return { text: text.slice(0, start) + left + selected + right + text.slice(end),
    start: start + left.length, end: end + left.length }
}
