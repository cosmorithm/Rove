/// <reference types="vite/client" />

interface Window {
  studyContextBridge: import('./studyContextTypes').StudyContextBridge
  codingBridge: import('./codingTypes').CodingBridge
  studyBridge: {
    openPdf(): Promise<{ name: string; pdfId: string } | null>
    getAIConfig(): Promise<import('./aiSettingsTypes').AIConfigPublic>
    saveAIConfig(input: import('./aiSettingsTypes').AIConfigDraft): Promise<import('./aiSettingsTypes').AIConfigPublic>
    listAIModels(input: import('./aiSettingsTypes').AIConfigDraft): Promise<string[]>
    testAIConfig(input: import('./aiSettingsTypes').AIConfigDraft): Promise<{ ok: true; model: string }>
    showEnvFile(): Promise<void>
    ask(request: { question: string; context: string }): Promise<string>
  }
}
