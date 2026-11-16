export type AIProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'qwen' | 'custom'
export type AIProtocol = 'openai' | 'anthropic'

export interface AIProviderPreset {
  id: AIProviderId
  name: string
  baseUrl: string
  protocol: AIProtocol
  defaultModel: string
  models: string[]
  requiresKey: boolean
}

export const aiProviders: readonly AIProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'openai',
    defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], requiresKey: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai',
    defaultModel: 'gpt-5.4-mini', models: ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini'], requiresKey: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic',
    defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], requiresKey: true },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai',
    defaultModel: 'gemini-3.8-flash', models: ['gemini-3.8-flash'], requiresKey: true },
  { id: 'qwen', name: '阿里云百炼 · Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai',
    defaultModel: 'qwen-plus', models: ['qwen-plus'], requiresKey: true },
  { id: 'custom', name: '自定义兼容接口', baseUrl: '', protocol: 'openai',
    defaultModel: '', models: [], requiresKey: false },
]

export interface AIConfigPublic {
  provider: AIProviderId
  baseUrl: string
  model: string
  configured: boolean
  hasApiKey: boolean
}

export interface AIConfigDraft {
  provider: AIProviderId
  baseUrl?: string
  model: string
  /** Empty input preserves the saved key only when provider and the complete base URL match. */
  apiKey?: string
  clearApiKey?: boolean
}
