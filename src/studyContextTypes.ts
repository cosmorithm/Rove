export type StudySummaryLevel = 'L0' | 'L1' | 'L2'
export interface StudyContextSelection { depth: number; level: StudySummaryLevel }
export interface StudyTurnSource {
  nodeId: string
  parentId?: string
  question: string
  answer: string
  answerVersion?: 'original' | 'edited'
  excerpt?: string
  excerptVersion?: 'original' | 'edited'
  page?: number
  document: { id: string; name: string; blockId: string; title: string }
  outcome?: 'completed' | 'failed' | 'demo'
}
export interface StudySummaryCache {
  text: string
  generatedAt: string
  model?: string
  inputTruncated?: boolean
  outputTruncated?: boolean
}
export interface StudyTurnVersion {
  revision: string
  source: StudyTurnSource
  createdAt: string
  state: 'pending' | 'ready' | 'failed'
  error?: string
  summaries: Partial<Record<StudySummaryLevel, StudySummaryCache>>
}
export interface StudyContextEntry {
  nodeId: string
  revision: string
  level: StudySummaryLevel
  /** The complete summary selected for this ancestor, before context clipping. */
  text: string
  /** UTF-16 units from the labeled ancestor section actually sent. */
  includedChars: number
  truncated: boolean
}
export interface PreparedStudyContext {
  /** Present on newly prepared requests; optional for older stored manifests. */
  nodeId?: string
  documentId?: string
  question?: string
  context: string
  selection: StudyContextSelection
  limit: number
  used: number
  truncated: boolean
  entries: StudyContextEntry[]
  omittedNodeIds: string[]
  materialsIncludedChars: number
  createdAt: string
}
export interface PrepareStudyContextRequest {
  nodeId: string
  documentId: string
  question: string
  /** Ancestors must be ordered from the selected leaf toward the root. */
  ancestors: StudyTurnSource[]
  selection: StudyContextSelection
  materials: string
  limit?: number
}
export interface StudyTurnMetadata {
  version: 1
  nodeId: string
  parentId?: string
  createdAt: string
  versions: StudyTurnVersion[]
  request?: PreparedStudyContext
  requestInput?: {
    question: string
    documentId: string
    selection: StudyContextSelection
    ancestorNodeIds: string[]
    createdAt: string
  }
  requestError?: string
}
export interface StudyContextBridge {
  save(source: StudyTurnSource): Promise<StudyTurnMetadata>
  get(nodeId: string): Promise<StudyTurnMetadata | null>
  prepare(request: PrepareStudyContextRequest): Promise<PreparedStudyContext>
}
