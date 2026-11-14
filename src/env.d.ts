/// <reference types="vite/client" />

interface Window {
  studyBridge: {
    openPdf(): Promise<{ name: string; pdfId: string } | null>
    getAIConfig(): Promise<{ baseUrl: string; model: string; configured: boolean }>
    showEnvFile(): Promise<void>
    ask(request: { question: string; context: string }): Promise<string>
  }
}
