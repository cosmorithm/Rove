import test from 'node:test'
import assert from 'node:assert/strict'
import { polishChatAnswer } from '../chatPolish.ts'
import { getAnswerRevisions, getActiveAnswerRevision, approveChatAnswerSpan } from '../chatVersions.ts'

const card = () => ({ id: 'turn-polish', question: '条件期望的定义需要什么前提？', answer: '原回答：要求可积。',
  editedAnswer: '旧修订：先检查可积性。', excerpt: '', children: [], demo: false })
function pending() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function entry(nodeId, length) {
  return { nodeId, revision: 'source-' + nodeId, level: 'L1', text: nodeId + '的完整摘要', includedChars: length, truncated: false }
}
function request() {
  return { nodeId: 'turn-polish', documentId: 'chat-1', question: '最初的问题',
    context: 'A'.repeat(600) + 'B'.repeat(700) + 'C'.repeat(800) + 'M'.repeat(900),
    selection: { depth: 3, level: 'L1' }, limit: 24000, used: 3000, truncated: false,
    entries: [entry('ancestor-a', 600), entry('ancestor-b', 700), entry('ancestor-c', 800)],
    omittedNodeIds: ['ancestor-d'], materialsIncludedChars: 900, createdAt: '2026-11-16T00:00:00Z' }
}
const input = { instruction: '补充适用条件并检查定义。', revisionId: 'original' }
const response = { answer: '完整的新回答：先验证随机变量可积，再讨论给定信息下的条件期望。', demo: false }

test('a completed polish appends a version while preserving both legacy answers and approvals', async () => {
  const turn = card()
  const approval = approveChatAnswerSpan(turn, 'original', 4, turn.answer.length)
  const oldRevisions = structuredClone(getAnswerRevisions(turn))
  const calls = []
  const inherited = request()
  const result = await polishChatAnswer(turn, input, async (question, context) => {
    calls.push({ question, context })
    assert.equal(turn.chatBusy, true)
    return response
  }, inherited)
  assert.equal(calls.length, 1)
  assert.equal(turn.answer, '原回答：要求可积。')
  assert.equal(turn.editedAnswer, '旧修订：先检查可积性。')
  assert.deepEqual(getAnswerRevisions(turn).slice(0, -1), oldRevisions)
  assert.equal(getAnswerRevisions(turn)[0].approvals[0].id, approval.id)
  assert.equal(getActiveAnswerRevision(turn).id, result.id)
  assert.equal(result.baseRevisionId, 'original', 'uses the explicitly selected source, including a historical version')
  assert.equal(result.kind, 'polish')
  assert.equal(result.instruction, input.instruction)
  assert.equal(result.text, response.answer)
  assert.equal(result.request.question, calls[0].question)
  assert.equal(result.request.context, calls[0].context)
  assert.equal(result.request.used, calls[0].context.length)
  assert.equal(result.request.nodeId, turn.id)
  assert.equal(result.request.documentId, inherited.documentId)
  assert.deepEqual(result.request.entries, inherited.entries)
  assert.deepEqual(result.request.omittedNodeIds, inherited.omittedNodeIds)
  assert.equal(result.request.truncated, false)
  assert.equal(result.request.materialsIncludedChars, calls[0].context.length - 2100)
  assert.equal(turn.chatBusy, false)
  assert.equal(turn.polishError, undefined)
})

test('generation, demo and invalid-answer failures keep the complete version history untouched', async () => {
  for (const ask of [
    async () => { throw new Error('模型服务超时') },
    async () => ({ answer: '演示内容', demo: true }),
    async () => ({ answer: '', demo: false }),
    async () => ({ answer: '\0', demo: false }),
  ]) {
    const turn = card()
    const before = JSON.stringify(getAnswerRevisions(turn))
    await assert.rejects(polishChatAnswer(turn, input, ask, request()))
    assert.equal(JSON.stringify(getAnswerRevisions(turn)), before)
    assert.equal(turn.activeAnswerId, undefined)
    assert.equal(turn.answer, '原回答：要求可积。')
    assert.equal(turn.chatBusy, false)
    assert.ok(turn.polishError)
  }
})

test('non-leaf, loading and busy nodes reject before sending any model request', async () => {
  for (const change of [turn => { turn.children.push(card()) }, turn => { turn.loading = true }, turn => { turn.chatBusy = true }]) {
    const turn = card()
    change(turn)
    const before = JSON.stringify(turn)
    let calls = 0
    await assert.rejects(polishChatAnswer(turn, input, async () => { calls++; return response }), /空闲的叶节点/)
    assert.equal(calls, 0)
    assert.equal(JSON.stringify(turn), before)
  }
})

test('the synchronous busy lock rejects a double submit while allowing the first request to finish', async () => {
  const turn = card(), gate = pending()
  let calls = 0
  const ask = async () => { calls++; return gate.promise }
  const first = polishChatAnswer(turn, input, ask, request())
  assert.equal(turn.chatBusy, true)
  await assert.rejects(polishChatAnswer(turn, input, ask, request()), /空闲的叶节点/)
  assert.equal(turn.chatBusy, true, 'a rejected duplicate cannot release the first operation lock')
  gate.resolve(response)
  await first
  assert.equal(calls, 1)
  assert.equal(getAnswerRevisions(turn).length, 3)
  assert.equal(turn.chatBusy, false)
})

test('a node that gains a child while waiting never switches its active version', async () => {
  const turn = card(), gate = pending()
  const before = JSON.stringify(getAnswerRevisions(turn))
  const task = polishChatAnswer(turn, input, async () => gate.promise, request())
  turn.children.push({ ...card(), id: 'child' })
  gate.resolve(response)
  await assert.rejects(task, /节点已展开/)
  assert.equal(turn.activeAnswerId, undefined)
  assert.equal(JSON.stringify(getAnswerRevisions(turn)), before)
  assert.equal(turn.children[0].id, 'child')
  assert.equal(turn.chatBusy, false)
})

test('invalid instructions and missing source versions fail before locking or requesting', async () => {
  for (const invalid of [{ instruction: '  ', revisionId: 'original' },
    { instruction: 'x'.repeat(2001), revisionId: 'original' }, { instruction: '检查', revisionId: 'missing' }]) {
    const turn = card(), before = JSON.stringify(turn)
    let calls = 0
    await assert.rejects(polishChatAnswer(turn, invalid, async () => { calls++; return response }))
    assert.equal(calls, 0)
    assert.equal(JSON.stringify(turn), before)
  }
})

test('clipping retains only actual ancestor spans, marks partial entries and records newly omitted nodes', async () => {
  const turn = card()
  turn.answer = '原'.repeat(23000)
  const inherited = request()
  let sent
  const result = await polishChatAnswer(turn, input, async (question, context) => { sent = { question, context }; return response }, inherited)
  const snapshot = result.request
  const prefixLength = sent.context.indexOf('A')
  const inheritedChars = sent.context.length - prefixLength
  assert.equal(snapshot.used, 24000)
  assert.equal(snapshot.context, sent.context)
  assert.equal(snapshot.question, sent.question)
  assert.match(sent.question, /截断内容/)
  assert.equal(snapshot.truncated, true)
  assert.ok(inheritedChars > 600 && inheritedChars < 1300)
  assert.deepEqual(snapshot.entries.map(item => [item.nodeId, item.includedChars, item.truncated]), [
    ['ancestor-a', 600, false], ['ancestor-b', inheritedChars - 600, true],
  ])
  assert.deepEqual(snapshot.omittedNodeIds, ['ancestor-c', 'ancestor-d'])
  assert.equal(snapshot.materialsIncludedChars, prefixLength)
  assert.equal(snapshot.entries[1].text, inherited.entries[1].text, 'the full summary stays available as provenance')
  assert.equal(inherited.entries[1].truncated, false)
  assert.equal(inherited.entries.length, 3)
})

test('an overlong base answer can exhaust the budget without claiming any ancestor was sent', async () => {
  const turn = card()
  turn.answer = '原'.repeat(25000)
  const result = await polishChatAnswer(turn, input, async () => response, request())
  assert.equal(result.request.used, 24000)
  assert.equal(result.request.truncated, true)
  assert.deepEqual(result.request.entries, [])
  assert.deepEqual(result.request.omittedNodeIds, ['ancestor-a', 'ancestor-b', 'ancestor-c', 'ancestor-d'])
  assert.equal(result.request.materialsIncludedChars, 24000)
})

test('the exact request snapshot is frozen before asynchronous work and keeps previous truncation', async () => {
  const turn = card(), inherited = request(), gate = pending()
  inherited.truncated = true
  inherited.entries[1].truncated = true
  const original = structuredClone(inherited)
  let sent
  const task = polishChatAnswer(turn, input, async (question, context) => { sent = { question, context }; return gate.promise }, inherited)
  inherited.context = '被更改的内容'
  inherited.selection.depth = 0
  inherited.entries[0].includedChars = 1
  inherited.omittedNodeIds.length = 0
  gate.resolve(response)
  const result = await task
  assert.equal(result.request.context, sent.context)
  assert.equal(result.request.question, sent.question)
  assert.equal(result.request.truncated, true)
  assert.deepEqual(result.request.selection, original.selection)
  assert.deepEqual(result.request.entries, original.entries)
  assert.deepEqual(result.request.omittedNodeIds, original.omittedNodeIds)
  assert.equal(result.request.materialsIncludedChars, result.request.context.length - 2100)
})

test('a request without an inherited snapshot remains usable and preserves Unicode boundaries', async () => {
  const turn = card()
  turn.answer = '😀'.repeat(13000)
  const result = await polishChatAnswer(turn, input, async (question, context) => {
    assert.ok(question.length < 4000)
    assert.ok(context.length <= 24000)
    assert.ok(!/[\uD800-\uDBFF]$/u.test(context))
    return response
  })
  assert.deepEqual(result.request.entries, [])
  assert.deepEqual(result.request.omittedNodeIds, [])
  assert.equal(result.request.materialsIncludedChars, result.request.context.length)
  assert.deepEqual(result.request.selection, { depth: 0, level: 'L1' })
})


test('recursive polish respects ancestor offsets inside earlier polish snapshots', async () => {
  const turn = card()
  turn.answer = '原'.repeat(23000)
  const first = await polishChatAnswer(turn, input, async () => response, request())
  const firstOffset = first.request.context.indexOf('A')
  assert.equal(first.request.entriesOffset, firstOffset)
  const secondInput = { instruction: '再检查遗漏的条件。', revisionId: first.id }
  const second = await polishChatAnswer(turn, secondInput, async () => response, first.request)
  const secondOffset = second.request.context.indexOf('A')
  assert.equal(second.request.entriesOffset, secondOffset)
  const actualAncestorCharacters = second.request.context.length - secondOffset
  assert.ok(actualAncestorCharacters > 600 && actualAncestorCharacters < first.request.entries.reduce((sum, item) => sum + item.includedChars, 0))
  assert.equal(second.request.entries.reduce((sum, item) => sum + item.includedChars, 0), actualAncestorCharacters)
  assert.deepEqual(second.request.entries.map(item => [item.nodeId, item.includedChars, item.truncated]), [
    ['ancestor-a', 600, false], ['ancestor-b', actualAncestorCharacters - 600, true],
  ])
  assert.equal(second.request.materialsIncludedChars, secondOffset)
  assert.deepEqual(second.request.omittedNodeIds, ['ancestor-c', 'ancestor-d'])
})

test('a retained polish prefix can push every ancestor outside a later request budget', async () => {
  const turn = card()
  const original = request()
  original.context = 'P'.repeat(23900) + 'A'.repeat(100)
  original.entries = [entry('ancestor-a', 100)]
  original.entriesOffset = 23900
  original.materialsIncludedChars = 23900
  original.omittedNodeIds = []
  turn.answer = 'base'.repeat(1000)
  const result = await polishChatAnswer(turn, input, async () => response, original)
  assert.equal(result.request.context.includes('A'), false)
  assert.deepEqual(result.request.entries, [])
  assert.deepEqual(result.request.omittedNodeIds, ['ancestor-a'])
  assert.equal(result.request.materialsIncludedChars, result.request.context.length)
  assert.equal(result.request.entriesOffset, result.request.context.length)
})


test('current character approvals enter the prompt before a long base, without granting approval to generated text', async () => {
  const turn = card()
  const verifiedText = '仅在可积性条件下成立。'
  turn.answer = '开头未审核的推测。' + '草稿'.repeat(13000) + verifiedText
  const start = turn.answer.indexOf(verifiedText)
  approveChatAnswerSpan(turn, 'original', start, start + verifiedText.length)
  turn.answerRevisions[0].approvals.push({ id: 'invalid', start: 0, end: 2, text: '伪造确认', createdAt: '2026-11-16T00:00:00Z' })
  let sent
  const result = await polishChatAnswer(turn, input, async (question, context) => { sent = { question, context }; return response }, request())
  assert.match(sent.question, /仅标为 Ground Truth 的用户审核原文已确认/)
  const wikiStart = sent.context.indexOf('【当前节点已审核原文 · Ground Truth】')
  const baseStart = sent.context.indexOf('【待打磨的回答 · 待核验】')
  assert.ok(wikiStart > 0 && baseStart > wikiStart)
  const wiki = sent.context.slice(wikiStart, baseStart)
  assert.ok(wiki.includes(verifiedText), 'approved tail text survives the context budget because it precedes the long base')
  assert.ok(!wiki.includes('伪造确认'))
  assert.ok(!wiki.includes('开头未审核的推测'))
  assert.equal(result.approvals, undefined)
  assert.equal(result.request.context, sent.context)
  assert.equal(result.request.entries.length, 0)
  assert.equal(turn.answerRevisions[0].approvals[0].text, verifiedText)
})
