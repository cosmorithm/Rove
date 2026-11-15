import type { StudyContextSelection } from './studyContextTypes'

export type AnswerVersion = 'original' | 'edited'

export interface AnswerClip {
  id: string
  text: string
  version: AnswerVersion
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
  excerptVersion?: AnswerVersion
}
