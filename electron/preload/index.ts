import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CodingBridge, CodeProgress } from '../../src/codingTypes'
import type { AIConfigDraft } from '../../src/aiSettingsTypes'
import type { StudyContextBridge } from '../../src/studyContextTypes'

contextBridge.exposeInMainWorld('studyBridge', {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  getAIConfig: () => ipcRenderer.invoke('ai:config'),
  saveAIConfig: (input: AIConfigDraft) => ipcRenderer.invoke('ai:save-config', input),
  listAIModels: (input: AIConfigDraft) => ipcRenderer.invoke('ai:list-models', input),
  testAIConfig: (input: AIConfigDraft) => ipcRenderer.invoke('ai:test-config', input),
  showEnvFile: () => ipcRenderer.invoke('ai:show-env'),
  ask: ({ question, context }: { question: string; context: string }) => ipcRenderer.invoke('ai:ask', { question, context })
})

const codingBridge: CodingBridge = {
  listProjects: () => ipcRenderer.invoke('coding:list-projects'),
  openProject: () => ipcRenderer.invoke('coding:open-project'),
  status: workspaceId => ipcRenderer.invoke('coding:status', workspaceId),
  readFile: request => ipcRenderer.invoke('coding:read-file', request),
  saveFile: request => ipcRenderer.invoke('coding:save-file', request),
  diff: request => ipcRenderer.invoke('coding:diff', request),
  checkpoint: request => ipcRenderer.invoke('coding:checkpoint', request),
  fork: request => ipcRenderer.invoke('coding:fork', request),
  trace: request => ipcRenderer.invoke('coding:trace', request),
  run: request => ipcRenderer.invoke('coding:run', request),
  cancel: runId => ipcRenderer.invoke('coding:cancel', runId),
  engine: () => ipcRenderer.invoke('coding:engine'),
  onProgress(callback) {
    const listener = (_event: IpcRendererEvent, progress: CodeProgress) => callback(progress)
    ipcRenderer.on('coding:progress', listener)
    return () => ipcRenderer.removeListener('coding:progress', listener)
  }
}
contextBridge.exposeInMainWorld('codingBridge', codingBridge)

const studyContextBridge: StudyContextBridge = {
  save: source => ipcRenderer.invoke('study-context:save', source),
  get: nodeId => ipcRenderer.invoke('study-context:get', nodeId),
  prepare: request => ipcRenderer.invoke('study-context:prepare', request)
}
contextBridge.exposeInMainWorld('studyContextBridge', studyContextBridge)

contextBridge.exposeInMainWorld('roveUpdates', {
  check: (...args: unknown[]) => ipcRenderer.invoke('updates:check', ...args),
  openGuide: (...args: unknown[]) => ipcRenderer.invoke('updates:open-guide', ...args),
})
