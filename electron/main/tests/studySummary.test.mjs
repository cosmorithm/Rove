import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudySummarizer } from '../studySummary.ts'

const key = 'test-secret-key-not-for-output'
const config = { publicConfig: { model: 'model-for-test', configured: true },
  endpoint: new URL('https://example.invalid/v1/chat/completions'), apiKey: key }
const source = () => ({ nodeId: 'turn-1', parentId: 'turn-0', question: '如何计算期望？', answer: '根据条件概率加权求和。',
  excerpt: 'E[X] = Σ xP(X=x)', answerVersion: 'original', excerptVersion: 'original', page: 4,
  document: { id: 'doc-1', name: '随机过程', blockId: 'point-1', title: '条件期望' }, outcome: 'completed' })
const payload = content => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) })
const levels = () => JSON.stringify({ L0: '期望的加权计算', L1: '按概率加权。', L2: '将各取值乘以对应概率后求和，须满足期望存在。' })

test('one configured request produces all three source-based cache levels', async () => {
  const calls = []
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async (url, options) => {
    calls.push({ url, options })
    return payload(levels())
  } })
  const result = await summarize(source())
  assert.equal(calls.length, 1)
  assert.deepEqual(result, { L0: '期望的加权计算', L1: '按概率加权。', L2: '将各取值乘以对应概率后求和，须满足期望存在。', model: 'model-for-test', inputTruncated: false })
  const { url, options } = calls[0]
  assert.equal(url.href, config.endpoint.href)
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers.Authorization, 'Bearer ' + key)
  assert.equal(options.signal.aborted, false)
  const body = JSON.parse(options.body)
  assert.equal(body.messages.length, 2)
  assert.equal(body.model, 'model-for-test')
  assert.equal(body.response_format, undefined, 'No provider-specific JSON capability is required')
  assert.match(body.messages[0].content, /不增加事实/)
  assert.match(body.messages[0].content, /L0 是自动标题/)
  assert.match(body.messages[1].content, /L0 标题/)
  assert.match(body.messages[1].content, /如何计算期望/)
  assert.match(body.messages[1].content, /E\[X\]/)
  assert.match(body.messages[1].content, /条件概率加权/)
  assert.match(body.messages[1].content, /"page":4/)
  assert.ok(!options.body.includes(key))
})

test('fenced JSON is accepted and output limits preserve complete Unicode', async () => {
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () =>
    payload('```json\n' + JSON.stringify({ L0: '题'.repeat(31) + '😀后', L1: '短'.repeat(239) + '😀后', L2: '详'.repeat(1199) + '😀后' }) + '\n```') })
  const result = await summarize(source())
  assert.equal(result.L0.length, 31)
  assert.equal(result.L1.length, 239)
  assert.equal(result.L2.length, 1199)
  assert.equal(result.outputTruncated, true)
  assert.ok(!/[\ud800-\udbff]$/.test(result.L0))
  assert.ok(!/[\ud800-\udbff]$/.test(result.L1))
  assert.ok(!/[\ud800-\udbff]$/.test(result.L2))
})

test('automatic titles are single-line plain text without heading or quote wrappers', async () => {
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () =>
    payload(JSON.stringify({ L0: '  ## 标题： “**条件期望\n  的加权计算**”  ', L1: '短摘要', L2: '详细摘要' })) })
  const result = await summarize(source())
  assert.equal(result.L0, '条件期望 的加权计算')
  assert.equal(result.outputTruncated, undefined)
})

test('the input budget retains questions and references before clipping long answers', async () => {
  let input
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async (_url, options) => {
    input = JSON.parse(options.body).messages[1].content
    return payload(levels())
  } })
  const turn = source()
  turn.answer = '开始' + '😀'.repeat(30_000) + '最后不应出现'
  const result = await summarize(turn)
  assert.equal(result.inputTruncated, true)
  assert.ok(input.length <= 24_000)
  assert.ok(input.indexOf('问题') < input.indexOf('本轮引用选段'))
  assert.ok(input.indexOf('本轮引用选段') < input.indexOf('本轮回答'))
  assert.ok(input.includes(turn.question) && input.includes(turn.excerpt))
  assert.match(input, /输入已截断/)
  assert.ok(!input.includes('最后不应出现'))
  assert.ok(!/[\ud800-\udbff]$/.test(input))
})

test('incomplete, empty or malformed summary levels fail instead of substituting another level', async () => {
  for (const content of [undefined, '', '{}', '{bad}', '[]', '{"L1":"one"}', '{"L1":"one","L2":""}',
    '{"L1":1,"L2":"two"}', '{"L1":"one","L2":"two"}',
    '{"L0":"","L1":"one","L2":"two"}', '{"L0":1,"L1":"one","L2":"two"}',
    '{"L0":"标题：","L1":"one","L2":"two"}', '{"L0":"title","L1":"one"}', '说明：{"L1":"one","L2":"two"}']) {
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () => payload(content) })
    await assert.rejects(summarize(source()), error => /摘要模型/.test(error.message))
  }
})

test('unconfigured, HTTP, response and transport failures never reveal provider credentials', async () => {
  let calls = 0
  const disabled = createStudySummarizer({ readConfig: async () => ({ ...config,
    publicConfig: { ...config.publicConfig, configured: false } }), fetch: async () => { calls++; return payload(levels()) } })
  await assert.rejects(disabled(source()), /先配置学习模型/)
  assert.equal(calls, 0)
  const failures = [
    async () => ({ ok: false, status: 401, json: async () => { throw new Error(key) } }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(key) } }),
    async () => { throw new Error('transport leaked ' + key) },
    async () => { throw new TypeError('network leaked ' + key) }
  ]
  for (const fetch of failures) {
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch })
    await assert.rejects(summarize(source()), error => !error.message.includes(key) && /摘要/.test(error.message))
  }
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () =>
    payload(JSON.stringify({ L0: '标题 ' + key, L1: '应隐藏 ' + key, L2: '更长的摘要 ' + key })) })
  const result = await summarize(source())
  assert.ok(!result.L0.includes(key) && !result.L1.includes(key) && !result.L2.includes(key))
  assert.match(result.L0, /密钥已省略/)
  assert.match(result.L1, /密钥已省略/)
})

test('the request deadline aborts pending provider work', async () => {
  const summarize = createStudySummarizer({ readConfig: async () => config, timeoutMs: 5,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException(key, 'AbortError')), { once: true })
    }) })
  await assert.rejects(summarize(source()), error => /摘要生成超时/.test(error.message) && !error.message.includes(key))
})
