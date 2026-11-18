import type { PreparedStudyContext, StudyContextSelection, StudyTurnSource } from './studyContextTypes'

export type AnswerVersion = 'original' | 'edited'

export interface AnswerClip {
  id: string
  text: string
  version: AnswerVersion
  answerRevisionId?: string
}

export interface ChatAnswerApproval {
  id: string
  /** Half-open UTF-16 range in the exact source revision. */
  start: number
  end: number
  text: string
  createdAt: string
}

export interface ChatAnswerRevision {
  readonly id: string
  readonly text: string
  readonly kind: 'original' | 'edit' | 'polish'
  /** Legacy answers retain an unknown creation time until a new revision is produced. */
  readonly createdAt?: string
  readonly instruction?: string
  readonly baseRevisionId?: string
  readonly request?: PreparedStudyContext
  approvals?: ChatAnswerApproval[]
}

export interface StudyContextRef {
  revision?: string
  /** L0 title cached for the selected answer revision; the original question stays intact. */
  title?: string
  state?: 'pending' | 'ready' | 'failed'
  request?: { selection: StudyContextSelection; used: number; limit: number; truncated: boolean; nodes: number }
  error?: string
}

export interface Card {
  id: string
  question: string
  answer: string
  editedAnswer?: string
  answerRevisions?: ChatAnswerRevision[]
  activeAnswerId?: string
  /** Unpublished manual edits, keyed by the exact answer version they started from. */
  answerDrafts?: Record<string, string>
  /** Immutable ancestor sources captured when this Chat node was created. */
  contextAncestors?: StudyTurnSource[]
  /** The actual context used for the node's first answer. Later polish keeps its own request. */
  contextSnapshot?: PreparedStudyContext
  parentAnswerRevisionId?: string
  /** A transient UI lock, excluded from persistence. */
  chatBusy?: boolean
  polishError?: string
  studyContext?: StudyContextRef
  excerpt: string
  excerptVersion?: AnswerVersion
  clips?: AnswerClip[]
  page?: number
  children: Card[]
  demo: boolean
  collapsed?: boolean
  loading?: boolean
}

export function answerText(card: Card, version?: AnswerVersion): string {
  if (version === undefined && card.activeAnswerId) {
    const selected = card.answerRevisions?.find(item => item.id === card.activeAnswerId)
    if (selected) return selected.text
    if (card.activeAnswerId === 'original') return card.answer
  }
  return version === 'original' ? card.answer : card.editedAnswer ?? card.answer
}

export function cardTitle(card: Card): string {
  const title = card.studyContext?.title
  return (typeof title === 'string' && title.trim()) || card.question
}

export interface CardQuestion {
  parent: Card
  question: string
  excerpt: string
  parentAnswer: string
  parentAnswerRevisionId?: string
  parentAnswerVersion?: AnswerVersion
  excerptVersion?: AnswerVersion
}
