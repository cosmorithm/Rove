import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('studyBridge', {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  getAIConfig: () => ipcRenderer.invoke('ai:config'),
  showEnvFile: () => ipcRenderer.invoke('ai:show-env'),
  ask: ({ question, context }: { question: string; context: string }) => ipcRenderer.invoke('ai:ask', { question, context })
})
