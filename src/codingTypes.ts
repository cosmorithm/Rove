export interface CodeWorkspace {
  id: string
  projectId: string
  path: string
  branch: string
  name: string
  isMain: boolean
}
export interface CodeProject { id: string; name: string; root: string; workspaces: CodeWorkspace[] }
export interface CodeStatus {
  workspace: CodeWorkspace
  head: string
  branch: string
  dirty: boolean
  files: string[]
  changes: { path: string; status: string }[]
}
export interface CodeFile { path: string; content: string; hash: string }
export interface CodeRunRequest { runId: string; workspaceId: string; prompt: string; context: string; kind: 'ask' | 'edit'; parentCommit?: string; nodeId?: string }
export interface CodeTraceRecord {
  version: 1
  seq: number
  at: string
  runId: string
  nodeId: string
  event: Record<string, unknown>
}
export interface CodeTraceInfo {
  format: 'jsonl-v1'
  partial?: boolean
  blob: string
  events: number
  bytes: number
  sha256: string
  runId: string
  nodeId: string
}
export interface CodeTracePage { records: CodeTraceRecord[]; next: number; done: boolean; available: boolean; complete?: boolean; partial?: boolean }
export interface CodeRunResult { answer: string; before: string; after: string; status: CodeStatus; cancelled: boolean; trace?: CodeTraceInfo }
export interface CodeProgress { runId: string; message: string; before?: string; record?: CodeTraceRecord }
export interface CodeEngine { available: boolean; version: string; authenticated: boolean; message: string }
export interface CodingBridge {
  listProjects(): Promise<CodeProject[]>
  openProject(): Promise<CodeProject | null>
  status(workspaceId: string): Promise<CodeStatus>
  readFile(request: {workspaceId: string; path: string; revision?: string}): Promise<CodeFile>
  saveFile(request: {workspaceId: string; path: string; content: string; expectedHash: string}): Promise<CodeFile>
  diff(request: {workspaceId: string; from?: string; to?: string}): Promise<string>
  checkpoint(request: {workspaceId: string; message: string}): Promise<CodeStatus>
  fork(request: {workspaceId: string; commit?: string; label?: string}): Promise<CodeWorkspace | null>
  trace(request: {workspaceId: string; nodeId: string; after?: number; limit?: number}): Promise<CodeTracePage>
  run(request: CodeRunRequest): Promise<CodeRunResult>
  cancel(runId: string): Promise<void>
  engine(): Promise<CodeEngine>
  onProgress(callback: (progress: CodeProgress) => void): () => void
}
