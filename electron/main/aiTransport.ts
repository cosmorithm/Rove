interface TransportConfig {
  endpoint: URL
  apiKey: string
  protocol?: 'openai' | 'anthropic'
}

/** Adapt the text-only request shape shared by Chat, polish, and summary generation. */
export function createAIRequest(config: TransportConfig, fetcher: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    if (!init || typeof init.body !== 'string') return fetcher(input, init)
    const body = JSON.parse(init.body)
    if (config.protocol === 'anthropic') {
      const headers = new Headers(init.headers)
      headers.set('anthropic-version', '2026-10-21')
      const system = body.messages.filter((item: { role: string }) => item.role === 'system')
        .map((item: { content: string }) => item.content).join('\n\n')
      const message = {
        model: body.model, max_tokens: body.max_tokens ?? 8192,
        ...(system ? { system } : {}),
        ...(/^claude-(?:sonnet|opus|haiku)-5/.test(body.model) ? { output_config: { effort: 'low' } } : {}),
        messages: body.messages.filter((item: { role: string }) => item.role !== 'system'),
      }
      const response = await fetcher(input, { ...init, headers, body: JSON.stringify(message) })
      if (!response.ok) return response
      const payload = await response.json() as {
        model?: string; content?: { type?: string; text?: string }[]; stop_reason?: string
      }
      const content = Array.isArray(payload.content)
        ? payload.content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : ''
      return Response.json({ model: payload.model, choices: [{ message: { content },
        finish_reason: payload.stop_reason === 'max_tokens' ? 'length' : payload.stop_reason === 'end_turn' ? 'stop' : payload.stop_reason,
      }] })
    }
    if (config.endpoint.origin === 'https://api.openai.com' && /^(?:gpt-[5-9](?:[.-]|$)|o\d)/.test(body.model) && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      // The older GPT-5 models support minimal effort, allowing a small summary budget.
      if (/^gpt-5(?:-mini|-nano)?(?:-2025-\d\d-\d\d)?$/.test(body.model)) body.reasoning_effort = 'minimal'
      return fetcher(input, { ...init, body: JSON.stringify(body) })
    }
    return fetcher(input, init)
  }
}
