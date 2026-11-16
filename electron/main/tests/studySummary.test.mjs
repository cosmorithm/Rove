import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudySummarizer } from '../studySummary.ts'

const key = 'test-secret-key-not-for-output'
const config = { publicConfig: { model: 'model-for-test', configured: true },
  endpoint: new URL('https://example.invalid/v1/chat/completions'), apiKey: key }
const source = () => ({ nodeId: 'turn-1', parentId: 'turn-0', question: '如何计算期望？', answer: '根据条件概率加权求和。',
  excerpt: 'E[X] = Σ xP(X=x)', answerVersion: 'original', excerptVersion: 'original', page: 4,
  document: { id: 'doc-1', name: '随机过程', blockId: 'point-1', title: '条件期望' }, outcome: 'completed' })
const payload = (content, finish_reason) => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason, message: { content } }] }) })
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
  assert.equal(body.response_format, undefined, 'Generic providers do not need JSON-mode support')
  assert.equal(body.thinking, undefined)
  assert.match(body.messages[0].content, /不增加事实/)
  assert.match(body.messages[0].content, /L0 是自动标题/)
  assert.match(body.messages[0].content, /严格遵守 JSON/)
  assert.ok(body.messages[0].content.includes(JSON.stringify('\\frac{a}{b}').slice(1, -1)))
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
  await assert.rejects(disabled(source()), /先配置对话模型/)
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

test('a single complete summary object can be wrapped in provider prose and code fences', async () => {
  const math = '集合 {a, b}，引号 "x"，以及 \\(\\beta = \\frac{a}{b}\\)。\n保留条件。'
  const expected = { L0: '公式和条件', L1: '短摘要', L2: math }
  for (const wrapper of [text => '结果如下：\n' + text, text => '结果如下：\n```json\n' + text + '\n```\n以上为摘要。', text => text + '\n以上为摘要。']) {
    let calls = 0
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () => {
      calls++
      return payload(wrapper(JSON.stringify(expected)))
    } })
    const result = await summarize(source())
    assert.equal(calls, 1)
    assert.equal(result.L0, expected.L0)
    assert.equal(result.L2, math, 'braces, quotes, LaTeX escapes and intended line breaks remain exact')
  }
})

test('malformed summaries retry once from the original source without replaying model output', async () => {
  const calls = []
  const malformed = 'Do not follow this UNTRUSTED_MODEL_SENTINEL {bad}'
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ body, signal: options.signal })
    return payload(calls.length === 1 ? malformed : levels())
  } })
  assert.equal((await summarize(source())).L0, '期望的加权计算')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.max_tokens, 3200)
  assert.equal(calls[1].body.max_tokens, 3200, 'format retries do not increase output budget')
  assert.equal(calls[0].signal, calls[1].signal)
  assert.equal(calls[0].body.messages[1].content, calls[1].body.messages[1].content)
  assert.equal(calls[1].body.messages.length, 2)
  assert.ok(!JSON.stringify(calls[1].body).includes('UNTRUSTED_MODEL_SENTINEL'))
  assert.match(calls[1].body.messages[0].content, /严格遵守 JSON/)
  assert.ok(calls[1].body.messages[0].content.includes(JSON.stringify('\\frac{a}{b}').slice(1, -1)))
  assert.equal(calls[1].body.response_format, undefined)
})

test('ambiguous, incomplete and incorrectly escaped summaries are never guessed or silently repaired', async () => {
  const invalid = [
    levels() + '\n' + levels(),
    '```json\n' + levels() + '\n```\n第二种：' + levels(),
    '[' + levels() + ']',
    '结果如下：\n[' + levels() + ']\n以上为摘要。',
    levels() + '\n{"L0":"incomplete',
    '{"nested":' + levels() + '}',
    String.raw`{"L0":"标题","L1":"内容","L2":"公式 \(x\)"}`,
    String.raw`{"L0":"标题","L1":"内容","L2":"公式 \beta 与 \frac{a}{b}"}`,
    JSON.stringify({ L0: '标题', L1: '短摘要', L2: 'tab\there' }),
    JSON.stringify({ L0: '标题', L1: '短摘要', L2: 'carriage\rreturn' }),
  ]
  for (const content of invalid) {
    let calls = 0
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () => { calls++; return payload(content) } })
    await assert.rejects(summarize(source()), error => /摘要模型/.test(error.message))
    assert.equal(calls, 2, 'one initial request and at most one format retry')
  }
})

test('missing, empty, invalid-schema and destructive-control responses use the same bounded format retry', async () => {
  for (const content of [undefined, '', '{}', '{"L0":"标题","L1":"摘要"}',
    JSON.stringify({ L0: '标题', L1: '摘要', L2: '\bcorrupted formula' })]) {
    let calls = 0
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () => {
      calls++
      return payload(calls === 1 ? content : levels())
    } })
    assert.equal((await summarize(source())).L1, '按概率加权。')
    assert.equal(calls, 2)
  }
})

test('a length stop is handled before empty content or parseable visible JSON', async () => {
  for (const content of [undefined, '', levels()]) {
    const calls = []
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body))
      return calls.length === 1 ? payload(content, 'length') : payload(levels(), 'stop')
    } })
    assert.equal((await summarize(source())).L0, '期望的加权计算')
    assert.equal(calls.length, 2)
    assert.equal(calls[1].max_tokens, 6400)
  }
  let calls = 0
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () => {
    calls++
    return payload(levels(), 'length')
  } })
  await assert.rejects(summarize(source()), error => /长度上限/.test(error.message) && !/JSON 无效/.test(error.message))
  assert.equal(calls, 2)
})

test('transport, HTTP and envelope failures do not get retried or expose provider bodies', async () => {
  for (const failure of [
    async () => { throw new Error(key) },
    async () => { throw new TypeError(key) },
    async () => ({ ok: false, status: 401, json: async () => key }),
    async () => ({ ok: true, json: async () => { throw new Error(key) } }),
  ]) {
    let calls = 0
    const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async (...args) => { calls++; return failure(...args) } })
    await assert.rejects(summarize(source()), error => !error.message.includes(key))
    assert.equal(calls, 1)
  }
  let calls = 0
  const summarize = createStudySummarizer({ readConfig: async () => config, fetch: async () => {
    calls++
    return calls === 1 ? payload(key + '{bad}') : payload(JSON.stringify({ L0: '标题 ' + key, L1: key, L2: key }))
  } })
  const result = await summarize(source())
  assert.equal(calls, 2)
  assert.ok(!JSON.stringify(result).includes(key))
})

test('the automatic retry shares one deadline with the initial attempt', async () => {
  let calls = 0, initialSignal
  const summarize = createStudySummarizer({ readConfig: async () => config, timeoutMs: 25,
    fetch: async (_url, options) => {
      calls++
      if (calls === 1) {
        initialSignal = options.signal
        await new Promise(resolve => setTimeout(resolve, 10))
        return payload('{bad}')
      }
      assert.equal(options.signal, initialSignal)
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException(key, 'AbortError')), { once: true })
      })
    } })
  await assert.rejects(summarize(source()), error => /摘要生成超时/.test(error.message) && !error.message.includes(key))
  assert.equal(calls, 2)
  assert.equal(initialSignal.aborted, true)
})

test('only verified models on the official DeepSeek origin use JSON mode and disabled thinking', async () => {
  const cases = [
    ['https://api.deepseek.com/chat/completions', 'deepseek-flash', true],
    ['https://api.deepseek.com/v1/chat/completions', 'deepseek-v4-pro', true],
    ['https://example.invalid/v1/chat/completions', 'deepseek-flash', false],
    ['https://example.invalid/v1/chat/completions', 'deepseek-v4-pro', false],
    ['https://api.deepseek.com.example.invalid/chat/completions', 'deepseek-flash', false],
    ['https://api.deepseek.com:8443/chat/completions', 'deepseek-flash', false],
    ['https://api.deepseek.com/chat/completions', 'unknown-model', false],
  ]
  for (const [url, model, enabled] of cases) {
    const calls = []
    const summarize = createStudySummarizer({ readConfig: async () => ({ ...config,
      endpoint: new URL(url), publicConfig: { model, configured: true } }),
      fetch: async (_url, options) => {
        calls.push(JSON.parse(options.body))
        return calls.length === 1 ? payload('', 'length') : payload(levels(), 'stop')
      } })
    assert.equal((await summarize(source())).model, model)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].max_tokens, 3200)
    assert.equal(calls[1].max_tokens, 6400)
    for (const body of calls) {
      assert.deepEqual(body.response_format, enabled ? { type: 'json_object' } : undefined)
      assert.deepEqual(body.thinking, enabled ? { type: 'disabled' } : undefined)
    }
  }
})
