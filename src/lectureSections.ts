import { parseLecture } from './lectureFormat'
import type { Block } from './library'

// Old builds stored every blank-line-delimited paragraph as a separate card host.
// Reuse the original IDs and card objects when folding paragraphs into chapters.
export function restoreLectureSections(blocks: Block[], pageCount: number): Block[] {
  const restored: Block[] = []
  for (let i = 0; i < blocks.length;) {
    if (blocks[i].title !== '讲义概览' || !/^知识点\s+\d+$/.test(blocks[i + 1]?.title || '')) {
      restored.push(blocks[i++])
      continue
    }
    const start = i++
    while (i < blocks.length && /^知识点\s+\d+$/.test(blocks[i].title)) i++
    const old = blocks.slice(start, i)
    const text = old.map(b => b.body).join('\n\n')
    const parsed = parseLecture(text, pageCount)
    if (!parsed.length) {
      restored.push(...old)
      continue
    }
    const anchors = parsed.map(section => {
      const needle = section.body.trim().split('\n').find(line => line.trim())?.trim()
      return needle ? old.findIndex(b => b.body.includes(needle)) : -1
    })
    let index = 0
    const groups = parsed.map(() => [] as Block[])
    old.forEach((block, n) => {
      // A chapter's heading may have its own old card. Include it with the body.
      while (index + 1 < anchors.length && anchors[index + 1] >= 0) {
        const firstBody = anchors[index + 1]
        const first = /^\s*#{1,6}\s+/.test(old[firstBody - 1]?.body || '') ? firstBody - 1 : firstBody
        if (n < first) break
        index++
      }
      groups[index].push(block)
    })
    restored.push(...parsed.map((section, n) => ({
      ...section,
      id: groups[n][0]?.id || crypto.randomUUID(),
      cards: groups[n].flatMap(block => block.cards)
    })))
  }
  return restored
}
