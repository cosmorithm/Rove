import test from 'node:test'
import assert from 'node:assert/strict'
import { createAIRequest } from '../aiTransport.ts'
import { createStudySummarizer } from '../studySummary.ts'

const endpoint = new URL('https://api.anthropic.com/v1/messages')
const init = () => ({ method: 'POST', redirect: 'error', signal: new AbortController().signal,
  headers: { Authorization: 'Bearer test-only-key', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 3200,
    messages: [{ role: 'system', content: 'Summarize faithfully.' }, { role: 'user', content: 'Source material.' }] }) })

test('Claude requests and responses preserve the shared text interface and token exhaustion', async () => {
  for (const [stop, expected] of [['end_turn', 'stop'], ['max_tokens', 'length']]) {
    const input = init()
    const request = createAIRequest({ endpoint, apiKey: 'test-only-key', protocol: 'anthropic' }, async (url, options) => {
      assert.equal(url, endpoint)
      assert.equal(options.signal, input.signal)
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.get('anthropic-version'), '2026-10-21')
      assert.equal(options.headers.get('Authorization'), 'Bearer test-only-key')
      const body = JSON.parse(options.body)
      assert.equal(body.system, 'Summarize faithfully.')
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Source material.' }])
      assert.equal(body.max_tokens, 3200)
      assert.equal(body.output_config.effort, 'low')
      assert.equal(body.response_format, undefined)
      return Response.json({ content: [{ type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' }], stop_reason: stop })
    })
    const payload = await (await request(endpoint, input)).json()
    assert.equal(payload.choices[0].message.content, 'First.\nSecond.')
    assert.equal(payload.choices[0].finish_reason, expected)
    assert.ok(!JSON.stringify(payload).includes('private reasoning'))
  }
})

test('Claude HTTP failures are preserved for caller error handling', async () => {
  const response = Response.json({ error: { message: 'not exposed by the adapter' } }, { status: 401 })
  const request = createAIRequest({ endpoint, apiKey: '', protocol: 'anthropic' }, async () => response)
  assert.equal(await request(endpoint, init()), response)
})

test('OpenAI reasoning models use the supported output-limit field on the official endpoint', async () => {
  for (const [url, model, rename] of [
    ['https://api.openai.com/v1/chat/completions', 'gpt-5-mini', true],
    ['https://api.openai.com/v1/chat/completions', 'gpt-5.4-mini', true],
    ['https://api.openai.com/v1/chat/completions', 'gpt-4.1-mini', false],
    ['https://example.invalid/v1/chat/completions', 'gpt-5-mini', false],
  ]) {
    const endpoint = new URL(url)
    const input = init()
    input.body = JSON.stringify({ model, max_tokens: 3200, messages: [] })
    const request = createAIRequest({ endpoint, apiKey: '', protocol: 'openai' }, async (_url, options) => {
      const body = JSON.parse(options.body)
      assert.equal(body.max_tokens, rename ? undefined : 3200)
      assert.equal(body.max_completion_tokens, rename ? 3200 : undefined)
      return Response.json({ choices: [] })
    })
    await request(endpoint, input)
  }
})

test('the normal summary entry point uses native Claude and caches all three returned levels', async () => {
  const levels = { L0: '主题', L1: '短摘要', L2: '保留条件的详细摘要' }
  const summarize = createStudySummarizer({ readConfig: async () => ({ endpoint, apiKey: 'test-only-key',
    protocol: 'anthropic', publicConfig: { configured: true, model: 'claude-sonnet-5-5' } }),
    fetch: async (url, options) => {
      assert.equal(url, endpoint)
      const body = JSON.parse(options.body)
      assert.match(body.system, /L0/)
      assert.deepEqual(body.messages.map(item => item.role), ['user'])
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(levels) }], stop_reason: 'end_turn' })
    } })
  const result = await summarize({ nodeId: 'test-node', question: '问题', answer: '回答',
    document: { id: 'doc', name: '会话', blockId: 'topic', title: '话题' } })
  for (const level of ['L0', 'L1', 'L2']) assert.equal(result[level], levels[level])
})
