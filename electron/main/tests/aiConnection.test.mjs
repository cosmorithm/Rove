import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIConnectionTools } from '../aiConnection.ts'

const key = 'fake-test-only-key'
const configuration = protocol => ({ apiKey: key, protocol,
  endpoint: new URL(protocol === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.deepseek.com/chat/completions'),
  publicConfig: { provider: protocol === 'anthropic' ? 'anthropic' : 'deepseek',
    model: protocol === 'anthropic' ? 'claude-sonnet-5-5' : 'deepseek-flash', hasApiKey: true, configured: true, baseUrl: '' } })

test('model discovery uses native headers and accepts an empty model without persisting drafts', async () => {
  for (const protocol of ['openai', 'anthropic']) {
    let calls = 0
    const config = configuration(protocol)
    const tools = createAIConnectionTools({ preview: async () => ({ ...config, publicConfig: { ...config.publicConfig, model: '' } }),
      fetch: async (url, options) => {
        calls++
        assert.match(url.pathname, /\/models$/)
        assert.equal(options.headers.get('Authorization'), 'Bearer ' + key)
        assert.equal(options.headers.get('anthropic-version'), protocol === 'anthropic' ? '2026-10-21' : null)
        assert.equal(options.redirect, 'error')
        return Response.json({ data: [{ id: 'first' }, { id: 'first' }, { id: 'second' }, {}] })
      } })
    assert.deepEqual(await tools.listModels({ provider: 'custom', model: '' }), ['first', 'second'])
    assert.equal(calls, 1)
  }
})

test('connection tests perform one text request through each provider protocol', async () => {
  for (const protocol of ['openai', 'anthropic']) {
    const config = configuration(protocol)
    const tools = createAIConnectionTools({ preview: async () => config, fetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      assert.equal(body.model, config.publicConfig.model)
      if (protocol === 'anthropic') return Response.json({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' })
      assert.deepEqual(body.thinking, { type: 'disabled' })
      return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
    } })
    assert.deepEqual(await tools.test({ provider: 'custom', model: 'ignored by fixture' }), { ok: true, model: config.publicConfig.model })
  }
})

test('failed, empty and capped provider replies do not pass the connection test', async () => {
  for (const response of [
    () => Response.json({ error: key }, { status: 401 }),
    () => Response.json({ error: key }, { status: 429 }),
    () => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
    () => Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }),
    () => new Response(key),
  ]) {
    const tools = createAIConnectionTools({ preview: async () => configuration('openai'), fetch: async () => response() })
    await assert.rejects(tools.test({ provider: 'deepseek', model: 'test' }), error => !error.message.includes(key))
  }
})

test('credential and model validation run before the network request', async () => {
  let calls = 0
  const config = configuration('openai')
  const tools = createAIConnectionTools({ preview: async () => ({ ...config, apiKey: '' }), fetch: async () => { calls++; throw Error(key) } })
  await assert.rejects(tools.listModels({ provider: 'deepseek', model: '' }), /API Key/)
  const noModel = createAIConnectionTools({ preview: async () => ({ ...config, publicConfig: { ...config.publicConfig, model: '' } }), fetch: async () => { calls++; throw Error(key) } })
  await assert.rejects(noModel.test({ provider: 'deepseek', model: '' }), /模型名称/)
  assert.equal(calls, 0)
})

test('connection checks abort and redact transport failures', async () => {
  const tools = createAIConnectionTools({ preview: async () => configuration('openai'), timeoutMs: 5,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException(key, 'AbortError')), { once: true })
    }) })
  await assert.rejects(tools.test({ provider: 'deepseek', model: 'test' }), error => /超时/.test(error.message) && !error.message.includes(key))
})
