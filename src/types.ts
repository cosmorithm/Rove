export type AnswerVersion = 'original' | 'edited'

export interface AnswerClip {
  id: string
  text: string
  version: AnswerVersion
}

export interface Card {
  id: string
  question: string
  answer: string
  editedAnswer?: string
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

export interface CardQuestion {
  parent: Card
  question: string
  excerpt: string
  parentAnswer: string
  excerptVersion?: AnswerVersion
}
