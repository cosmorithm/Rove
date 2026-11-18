import test from 'node:test'
import assert from 'node:assert/strict'
import { splitEditorBlocks, editorBlockText, formatEditorSelection } from '../nodeEditorBlocks.ts'

test('source round-trips exactly, including blank lines, CRLF, trailing Markdown hard breaks and empty input', () => {
  for (const source of ['', '  ', '\r\n\t\n', '  \n# 标题\r\n\r\n🧭 text  \r\nnext\r\n \t\r\n',
    '## 标题\r> 摘要\n\n\tcode\n', 'plain without final newline']) {
    const blocks = splitEditorBlocks(source)
    assert.ok(blocks.length)
    assert.equal(blocks.join(''), source)
    for (const raw of blocks) {
      const { body, tail } = editorBlockText(raw)
      assert.equal(body + tail, raw)
    }
  }
  assert.deepEqual(splitEditorBlocks(''), [''])
  assert.deepEqual(editorBlockText('a  \r\n  \r\n\t'), { body: 'a  ', tail: '\r\n  \r\n\t' })
})

test('sections become separate editing blocks without breaking tables, fenced code or display math', () => {
  const expected = ['# Title\n', '## Two\n', 'Intro\n\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n',
    '````js\n# fake heading\n\n```\n\n````\n',
    '$$\nx+y\n\n# still math\n$$\n', '\\[x\n\ny\\]\n',
    '## Real heading\n', 'Last']
  assert.deepEqual(splitEditorBlocks(expected.join('')), expected)
  const unclosed = '~~~text\n# literal\n\nstill code'
  assert.deepEqual(splitEditorBlocks(unclosed), [unclosed])
})

test('loose lists, nested fenced material, blockquotes and indented code can be edited together', () => {
  const expected = ['Intro\n\n',
    '- first\n\n  continuation\n\n  ```txt\n\n  # in fence\n  ```\n\n- second\n\n',
    '> one\n>\n> ```\n>\n> ```\n\n',
    '    code\n\n    more code\n\n', 'After']
  assert.deepEqual(splitEditorBlocks(expected.join('')), expected)
})

test('selection formatting uses UTF-16 offsets and returns usable positions for add, remove and insertion', () => {
  const bold = formatEditorSelection('a🧭b', 1, 3, 'bold')
  assert.deepEqual(bold, { text: 'a**🧭**b', start: 3, end: 5 })
  assert.deepEqual(formatEditorSelection(bold.text, bold.start, bold.end, 'bold'), { text: 'a🧭b', start: 1, end: 3 })
  const both = formatEditorSelection(bold.text, bold.start, bold.end, 'italic')
  assert.deepEqual(both, { text: 'a***🧭***b', start: 4, end: 6 })
  assert.deepEqual(formatEditorSelection(both.text, both.start, both.end, 'italic'), bold)
  assert.deepEqual(formatEditorSelection('甲乙', 1, 1, 'italic'), { text: '甲**乙', start: 2, end: 2 })
  const code = formatEditorSelection('`hi`', 0, 4, 'code')
  assert.deepEqual(code, { text: '`` `hi` ``', start: 3, end: 7 })
  assert.deepEqual(formatEditorSelection(code.text, code.start, code.end, 'code'), { text: '`hi`', start: 0, end: 4 })
})
