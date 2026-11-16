import test from 'node:test'
import assert from 'node:assert/strict'
import { answerText } from '../types.ts'
import {
  getAnswerRevisions, getActiveAnswerRevision, getChatAnswerRevision, selectChatAnswerRevision,
  appendChatAnswerRevision, approveChatAnswerSpan, revokeChatAnswerSpan, groundTruthText,
} from '../chatVersions.ts'

const card = () => ({ id: 'turn-1', question: '什么是条件期望？', answer: '原始回答：满足可积性条件。',
  excerpt: '', children: [], demo: false })
const request = () => ({ context: '固定的祖先摘要', selection: { depth: 2, level: 'L1' }, limit: 24000, used: 8,
  truncated: false, entries: [], omittedNodeIds: [], materialsIncludedChars: 0, createdAt: '2026-11-16T00:00:00Z' })

test('legacy answers are readable without a write and migrate with stable identities', () => {
  const turn = { ...card(), editedAnswer: '旧修订版' }
  const before = JSON.stringify(turn)
  assert.deepEqual(getAnswerRevisions(turn).map(revision => [revision.id, revision.text]), [
    ['original', turn.answer], ['edited', turn.editedAnswer],
  ])
  assert.equal(getActiveAnswerRevision(turn).id, 'edited')
  assert.equal(JSON.stringify(turn), before)
  const revision = appendChatAnswerRevision(turn, { text: '第一次打磨', kind: 'polish' })
  assert.equal(getActiveAnswerRevision(turn).id, revision.id)
  assert.deepEqual(getAnswerRevisions(turn).map(item => item.id), ['original', 'edited', revision.id])
  assert.equal(turn.answer, '原始回答：满足可积性条件。')
  assert.equal(turn.editedAnswer, '旧修订版')
  assert.equal(answerText(turn), '第一次打磨')
  assert.equal(answerText(turn, 'original'), turn.answer)
  assert.equal(answerText(turn, 'edited'), '旧修订版')
})

test('polish and edits append independently, preserving their base and exact request snapshot', () => {
  const turn = card()
  const inherited = request()
  const polished = appendChatAnswerRevision(turn, { text: '打磨后的内容', kind: 'polish', instruction: '补充前提', request: inherited })
  inherited.context = '后来改变的上下文'
  assert.equal(polished.request.context, '固定的祖先摘要')
  assert.equal(polished.baseRevisionId, 'original')
  const edited = appendChatAnswerRevision(turn, { text: '用户修正后的内容', kind: 'edit' })
  assert.equal(edited.baseRevisionId, polished.id)
  assert.equal(getChatAnswerRevision(turn, polished.id).text, '打磨后的内容')
  selectChatAnswerRevision(turn, 'original')
  assert.equal(answerText(turn), turn.answer)
  selectChatAnswerRevision(turn, edited.id)
  assert.equal(answerText(turn), '用户修正后的内容')
  assert.equal(getAnswerRevisions(turn).length, 3)
})

test('only idle leaf nodes can append or select the active answer', () => {
  for (const change of [turn => { turn.children.push(card()) }, turn => { turn.loading = true }, turn => { turn.chatBusy = true }]) {
    const turn = card()
    change(turn)
    const before = JSON.stringify(turn)
    assert.throws(() => appendChatAnswerRevision(turn, { text: '新回答', kind: 'polish' }), /叶节点|等待/)
    assert.throws(() => selectChatAnswerRevision(turn, 'original'), /叶节点|等待/)
    assert.equal(JSON.stringify(turn), before)
  }
})

test('invalid append or selection leaves every historical field untouched', () => {
  const turn = card()
  for (const input of [{ text: '', kind: 'polish' }, { text: '\0', kind: 'polish' },
    { text: '新回答', kind: 'other' }, { text: '新回答', kind: 'edit', baseRevisionId: 'missing' }]) {
    const before = JSON.stringify(turn)
    assert.throws(() => appendChatAnswerRevision(turn, input))
    assert.equal(JSON.stringify(turn), before)
  }
  assert.throws(() => selectChatAnswerRevision(turn, 'missing'), /找不到/)
  assert.equal(turn.activeAnswerId, undefined)
})

test('character approvals are bound to a precise revision and survive later leaf polish', () => {
  const turn = card()
  assert.equal(groundTruthText(turn), '')
  const approved = approveChatAnswerSpan(turn, 'original', 5, turn.answer.length)
  const first = groundTruthText(turn)
  assert.match(first, /节点 turn-1 · 回答 original · 字符 5–/)
  assert.match(first, /满足可积性条件/)
  assert.ok(!first.includes('原始回答'))
  assert.equal(approveChatAnswerSpan(turn, 'original', 5, turn.answer.length).id, approved.id)
  assert.equal(getChatAnswerRevision(turn, 'original').approvals.length, 1)
  const revision = appendChatAnswerRevision(turn, { text: '尚未审核的新内容', kind: 'polish',
    approvals: [{ id: 'model-approval', start: 0, end: 8, text: '尚未审核的新内容', createdAt: new Date().toISOString() }] })
  assert.equal(revision.approvals, undefined)
  assert.equal(groundTruthText(turn), first)
  assert.ok(!groundTruthText(turn).includes('尚未审核'))
  revokeChatAnswerSpan(turn, 'original', approved.id)
  assert.equal(groundTruthText(turn), '')
})

test('review can happen on historical non-leaf versions and supports independent ranges', () => {
  const turn = card()
  turn.children.push(card())
  approveChatAnswerSpan(turn, 'original', 0, 4)
  approveChatAnswerSpan(turn, 'original', 5, turn.answer.length)
  const result = groundTruthText(turn)
  assert.equal(getChatAnswerRevision(turn, 'original').approvals.length, 2)
  assert.ok(result.includes('原始回答') && result.includes('满足可积性条件'))
  assert.equal(turn.children.length, 1)
})

test('approval boundaries reject partial surrogate pairs and preserve exact Unicode', () => {
  const turn = { ...card(), answer: 'A😀B，定义。' }
  for (const [start, end] of [[1, 2], [2, 3], [-1, 3], [1.1, 3], [0, 99], [3, 3]]) {
    assert.throws(() => approveChatAnswerSpan(turn, 'original', start, end), /字符范围/)
  }
  const approval = approveChatAnswerSpan(turn, 'original', 1, 3)
  assert.equal(approval.text, '😀')
  assert.ok(groundTruthText(turn).endsWith('😀'))
})

test('corrupted source-span pairs and whitespace approvals cannot become Ground Truth', () => {
  const turn = card()
  const approval = approveChatAnswerSpan(turn, 'original', 5, turn.answer.length)
  const source = getChatAnswerRevision(turn, 'original')
  source.approvals[0] = { ...approval, text: '伪造的认可内容' }
  assert.equal(groundTruthText(turn), '')
  source.approvals[0] = { ...approval, start: -1 }
  assert.equal(groundTruthText(turn), '')
  const whitespace = { ...card(), answer: '  有效内容' }
  assert.throws(() => approveChatAnswerSpan(whitespace, 'original', 0, 2), /字符范围/)
})
