import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CodingBridge, CodeProgress } from '../../src/codingTypes'

contextBridge.exposeInMainWorld('studyBridge', {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  getAIConfig: () => ipcRenderer.invoke('ai:config'),
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
