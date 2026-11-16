import type { Card, ChatAnswerApproval, ChatAnswerRevision } from './types'

type RevisionInput = Pick<ChatAnswerRevision, 'text' | 'kind' | 'instruction' | 'baseRevisionId' | 'request'>

/** Legacy originals and edits get stable IDs without modifying stored data during reads. */
export function getAnswerRevisions(card: Card): ChatAnswerRevision[] {
  const stored = card.answerRevisions ?? []
  const legacy: ChatAnswerRevision[] = []
  if (!stored.some(item => item.id === 'original')) legacy.push({ id: 'original', text: card.answer, kind: 'original' })
  if (card.editedAnswer !== undefined && !stored.some(item => item.id === 'edited')) {
    legacy.push({ id: 'edited', text: card.editedAnswer, kind: 'edit', baseRevisionId: 'original' })
  }
  return [...legacy, ...stored]
}

export function getChatAnswerRevision(card: Card, id: string): ChatAnswerRevision | undefined {
  return getAnswerRevisions(card).find(item => item.id === id)
}

export function getActiveAnswerRevision(card: Card): ChatAnswerRevision {
  const revisions = getAnswerRevisions(card)
  return revisions.find(item => item.id === card.activeAnswerId)
    ?? revisions.find(item => item.id === (card.editedAnswer !== undefined ? 'edited' : 'original'))!
}

function requireIdle(card: Card) {
  if (card.loading || card.chatBusy) throw new Error('请等待当前回答完成。')
}

function requireLeaf(card: Card) {
  requireIdle(card)
  if (card.children.length) throw new Error('只有叶节点可以打磨或修改当前回答版本。')
}

export function selectChatAnswerRevision(card: Card, id: string) {
  requireLeaf(card)
  if (!getChatAnswerRevision(card, id)) throw new Error('找不到所选回答版本。')
  card.activeAnswerId = id
}

/** Append a complete answer only after generation succeeds. The original answer is immutable. */
export function appendChatAnswerRevision(card: Card, input: RevisionInput): ChatAnswerRevision {
  requireLeaf(card)
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1_000_000 || input.text.includes('\0')) {
    throw new Error('回答版本内容无效。')
  }
  if (!['original', 'edit', 'polish'].includes(input.kind)) throw new Error('回答版本类型无效。')
  const revisions = getAnswerRevisions(card)
  const baseRevisionId = input.baseRevisionId ?? getActiveAnswerRevision(card).id
  if (!revisions.some(item => item.id === baseRevisionId)) throw new Error('找不到生成所依据的回答版本。')
  const revision: ChatAnswerRevision = {
    id: crypto.randomUUID(), text: input.text, kind: input.kind, createdAt: new Date().toISOString(), baseRevisionId,
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(input.request !== undefined ? { request: JSON.parse(JSON.stringify(input.request)) } : {}),
  }
  card.answerRevisions = [...revisions, revision]
  card.activeAnswerId = revision.id
  return revision
}

function validBoundary(text: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]))
}

function validApproval(revision: ChatAnswerRevision, approval: ChatAnswerApproval) {
  return validBoundary(revision.text, approval.start) && validBoundary(revision.text, approval.end)
    && approval.start < approval.end && Boolean(approval.text.trim())
    && revision.text.slice(approval.start, approval.end) === approval.text
}

export function approveChatAnswerSpan(card: Card, revisionId: string, start: number, end: number): ChatAnswerApproval {
  requireIdle(card)
  const revisions = getAnswerRevisions(card)
  const revision = revisions.find(item => item.id === revisionId)
  if (!revision) throw new Error('找不到待审核的回答版本。')
  if (!validBoundary(revision.text, start) || !validBoundary(revision.text, end) || start >= end || !revision.text.slice(start, end).trim()) {
    throw new Error('请选择有效的字符范围，范围不能截断完整字符。')
  }
  const existing = revision.approvals?.find(item => item.start === start && item.end === end && validApproval(revision, item))
  if (existing) return existing
  const approval: ChatAnswerApproval = { id: crypto.randomUUID(), start, end,
    text: revision.text.slice(start, end), createdAt: new Date().toISOString() }
  card.answerRevisions = revisions.map(item => item.id === revisionId
    ? { ...item, approvals: [...(item.approvals ?? []), approval] } : item)
  return approval
}

export function revokeChatAnswerSpan(card: Card, revisionId: string, approvalId: string) {
  requireIdle(card)
  const revisions = getAnswerRevisions(card)
  if (!revisions.some(item => item.id === revisionId)) throw new Error('找不到待撤回审核的回答版本。')
  card.answerRevisions = revisions.map(item => item.id === revisionId
    ? { ...item, approvals: item.approvals?.filter(approval => approval.id !== approvalId) } : item)
}

/** Only exact, user-approved source spans can enter the Ground Truth context. */
export function groundTruthText(card: Card): string {
  const sections: string[] = []
  for (const revision of getAnswerRevisions(card)) {
    for (const approval of revision.approvals ?? []) {
      if (validApproval(revision, approval)) {
        sections.push('【Ground Truth · 节点 ' + card.id + ' · 回答 ' + revision.id + ' · 字符 ' + approval.start + '–' + approval.end + '】\n' + approval.text)
      }
    }
  }
  return sections.join('\n\n')
}
