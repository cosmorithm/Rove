import { createAIRequest } from './aiTransport.ts'
import { aiProviders, type AIConfigDraft } from '../../src/aiSettingsTypes.ts'
import type { AIModelConfig } from './aiConfig'

class ConnectionError extends Error {}

export function createAIConnectionTools(options: {
  preview(input: AIConfigDraft): Promise<AIModelConfig>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}) {
  const fetcher = options.fetch ?? globalThis.fetch
  async function run<T>(input: AIConfigDraft, action: (config: AIModelConfig, signal: AbortSignal) => Promise<T>) {
    const config = await options.preview(input)
    const provider = aiProviders.find(item => item.id === config.publicConfig.provider)
    if (provider?.requiresKey && !config.apiKey) throw new ConnectionError('请先填写此厂商的 API Key。')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000)
    try { return await action(config, controller.signal) }
    catch (error) {
      if (controller.signal.aborted || (error as Error)?.name === 'AbortError') throw new ConnectionError('连接超时，请检查地址和网络。')
      if (error instanceof ConnectionError) throw error
      throw new ConnectionError('无法连接模型服务，请检查服务地址和网络。')
    } finally { clearTimeout(timer) }
  }
  function check(response: Response) {
    if (response.status === 401 || response.status === 403) throw new ConnectionError('鉴权失败，请检查 API Key 和模型访问权限。')
    if (response.status === 429) throw new ConnectionError('请求受限，请检查账户额度或稍后重试。')
    if (!response.ok) throw new ConnectionError('模型服务返回 HTTP ' + response.status + '，请检查地址和模型名称。')
  }
  return {
    listModels(input: AIConfigDraft) {
      return run(input, async (config, signal) => {
        const url = new URL(config.endpoint)
        url.pathname = url.pathname.replace(/\/(?:chat\/completions|messages)\/?$/, '/models')
        const headers = new Headers(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {})
        if (config.protocol === 'anthropic') headers.set('anthropic-version', '2026-10-21')
        const response = await fetcher(url, { headers, redirect: 'error', signal })
        check(response)
        const data = await response.json() as { data?: { id?: unknown }[] }
        const models = [...new Set((Array.isArray(data.data) ? data.data : [])
          .map(item => item.id).filter((id): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 200))]
          .slice(0, 300)
        if (!models.length) throw new ConnectionError('服务未提供模型列表，可以直接输入模型名称。')
        return models
      })
    },
    test(input: AIConfigDraft) {
      return run(input, async (config, signal) => {
        const model = config.publicConfig.model
        if (!model) throw new ConnectionError('请先选择或填写模型名称。')
        const request = createAIRequest(config, fetcher)
        const deepseek = config.endpoint.origin === 'https://api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)
        const response = await request(config.endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
          body: JSON.stringify({ model, max_tokens: 1024, ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
            messages: [{ role: 'user', content: 'Reply with OK.' }] }),
        })
        check(response)
        const payload = await response.json() as { choices?: { finish_reason?: string; message?: { content?: string } }[] }
        if (payload.choices?.[0]?.finish_reason === 'length') throw new ConnectionError('模型达到测试输出上限，请选择另一个模型后重试。')
        if (typeof payload.choices?.[0]?.message?.content !== 'string' || !payload.choices[0].message.content.trim()) {
          throw new ConnectionError('服务已响应，但未返回可用文本，请检查模型是否支持对话。')
        }
        return { ok: true as const, model }
      })
    },
  }
}
