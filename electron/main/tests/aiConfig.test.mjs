import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { createAIConfigStore, normalizeAIBaseUrl } from '../aiConfig.ts'
import { aiProviders } from '../../../src/aiSettingsTypes.ts'

const secret = 'test-only-provider-secret'
async function fixture(initial) {
  const dir = await mkdtemp(join(tmpdir(), 'rove-ai-config-'))
  const envFile = join(dir, '.env')
  if (initial !== undefined) await writeFile(envFile, initial)
  return { dir, envFile, store: createAIConfigStore({ envFile }), cleanup: () => rm(dir, { recursive: true, force: true }) }
}
const deepseek = key => 'OPENAI_BASE_URL=https://api.deepseek.com/v1/\nOPENAI_MODEL=deepseek-flash\nOPENAI_API_KEY=' + key + '\n'

test('legacy env settings infer the provider without changing the file or returning its key publicly', async () => {
  const original = deepseek(secret)
  const f = await fixture(original)
  try {
    const config = await f.store.read()
    assert.deepEqual(config.publicConfig, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash', configured: true, hasApiKey: true })
    assert.equal(config.protocol, 'openai')
    assert.equal(config.endpoint.href, 'https://api.deepseek.com/v1/chat/completions')
    assert.equal(config.apiKey, secret)
    assert.ok(!JSON.stringify(config.publicConfig).includes(secret))
    assert.equal(await readFile(f.envFile, 'utf8'), original)
  } finally { await f.cleanup() }
})

test('missing configuration stays unconfigured and does not silently add a default model', async () => {
  const f = await fixture()
  try {
    let config = await f.store.read()
    assert.equal(config.publicConfig.provider, 'openai')
    assert.equal(config.publicConfig.model, '')
    assert.equal(config.publicConfig.configured, false)
    assert.deepEqual(await readdir(f.dir), [])
    await writeFile(f.envFile, 'ROVE_AI_PROVIDER=deepseek\nOPENAI_API_KEY=' + secret)
    config = await f.store.read()
    assert.equal(config.publicConfig.baseUrl, 'https://api.deepseek.com')
    assert.equal(config.publicConfig.model, '')
    assert.equal(config.publicConfig.configured, false)
  } finally { await f.cleanup() }
})

test('each preset resolves its protocol and supports a service-address override', async () => {
  const f = await fixture()
  try {
    for (const provider of aiProviders.filter(item => item.id !== 'custom')) {
      const preview = await f.store.preview({ provider: provider.id, model: provider.defaultModel, apiKey: secret })
      assert.equal(preview.publicConfig.baseUrl, provider.baseUrl)
      assert.equal(preview.protocol, provider.protocol)
      assert.ok(preview.endpoint.pathname.endsWith(provider.protocol === 'anthropic' ? '/messages' : '/chat/completions'))
      assert.equal(preview.publicConfig.configured, true)
    }
    const proxy = await f.store.preview({ provider: 'anthropic', baseUrl: 'https://proxy.invalid/team/v1/', model: 'test-model', apiKey: secret })
    assert.equal(proxy.endpoint.href, 'https://proxy.invalid/team/v1/messages')
    assert.equal(proxy.protocol, 'anthropic')
    assert.deepEqual(await readdir(f.dir), [])
  } finally { await f.cleanup() }
})

test('save preserves unrelated variables, comments, exports, quoted multiline text and CRLF', async () => {
  const original = '\uFEFF# Existing settings\r\nexport OPENAI_BASE_URL=https://api.deepseek.com/v1/ # custom region\r\n' +
    'OPENAI_MODEL=old-model\r\nOPENAI_API_KEY=' + secret + ' # credential note\r\n' +
    '# Coding settings\r\nDEEPSEEK_API_KEY=coding-test-secret\r\nDEEPSEEK_MODEL=coding-model\r\n' +
    "OTHER_TEXT='first line\r\nOPENAI_MODEL=inside-another-value\r\nlast line'\r\nOPENAI_MODEL=duplicate\r\n"
  const f = await fixture(original)
  try {
    const result = await f.store.save({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' })
    assert.equal(result.hasApiKey, true)
    const saved = await readFile(f.envFile, 'utf8')
    const env = parseEnv(saved.replace(/^\uFEFF/u, ''))
    assert.equal(env.ROVE_AI_PROVIDER, 'deepseek')
    assert.equal(env.OPENAI_MODEL, 'deepseek-v4-pro')
    assert.equal(env.OPENAI_API_KEY, secret)
    assert.equal(env.DEEPSEEK_API_KEY, 'coding-test-secret')
    assert.equal(env.DEEPSEEK_MODEL, 'coding-model')
    assert.equal(env.OTHER_TEXT, 'first line\nOPENAI_MODEL=inside-another-value\nlast line')
    assert.ok(saved.includes('# Existing settings\r\n'))
    assert.ok(saved.includes('# custom region\r\n'))
    assert.ok(saved.includes('# credential note\r\n'))
    assert.ok(saved.includes('# Coding settings\r\nDEEPSEEK_API_KEY=coding-test-secret\r\nDEEPSEEK_MODEL=coding-model\r\n'))
    assert.equal((await stat(f.envFile)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(f.dir), ['.env'])
  } finally { await f.cleanup() }
})

test('dotenv encoding preserves literal backslashes, quotes and comment characters exactly', async () => {
  const f = await fixture()
  try {
    for (const key of ['hash#inside', String.raw`literal\nsequence`, 'double"quote', "single'quote", `both'"quotes`, 'back`tick']) {
      const saved = await f.store.save({ provider: 'custom', baseUrl: 'https://service.invalid/v1', model: 'test-model', apiKey: key })
      assert.equal(saved.hasApiKey, true)
      assert.equal((await f.store.read()).apiKey, key)
    }
    const before = await readFile(f.envFile, 'utf8')
    await assert.rejects(f.store.save({ provider: 'custom', model: 'test-model', apiKey: `a'"\`#unsafely-quoted` }), /无法保存在/)
    assert.equal(await readFile(f.envFile, 'utf8'), before)
  } finally { await f.cleanup() }
})

test('blank keys are retained only for the same provider and complete normalized target', async () => {
  const f = await fixture(deepseek(secret))
  try {
    const same = await f.store.preview({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/', model: '' })
    assert.equal(same.apiKey, secret)
    assert.equal(same.publicConfig.model, '')
    assert.equal(same.publicConfig.configured, false)
    for (const input of [
      { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/another-route', model: 'test' },
      { provider: 'deepseek', baseUrl: 'https://proxy.invalid/v1', model: 'test' },
      { provider: 'custom', baseUrl: 'https://api.deepseek.com/v1', model: 'test' },
    ]) assert.equal((await f.store.preview(input)).apiKey, '')
    const saved = await f.store.save({ provider: 'openai', model: 'gpt-5-mini' })
    assert.equal(saved.hasApiKey, false)
    assert.equal(saved.configured, false)
    assert.equal((await f.store.read()).apiKey, '')
  } finally { await f.cleanup() }
})

test('keys can be explicitly cleared or replaced, while no-key local compatible servers remain usable', async () => {
  const f = await fixture(deepseek(secret))
  try {
    let result = await f.store.save({ provider: 'deepseek', model: 'deepseek-flash', clearApiKey: true })
    assert.equal(result.hasApiKey, false)
    assert.equal(result.configured, false)
    result = await f.store.save({ provider: 'deepseek', model: 'deepseek-flash', clearApiKey: true, apiKey: 'replacement-test-key' })
    assert.equal(result.configured, true)
    assert.equal((await f.store.read()).apiKey, 'replacement-test-key')
    result = await f.store.save({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'local-model' })
    assert.equal(result.configured, true)
    assert.equal(result.hasApiKey, false)
  } finally { await f.cleanup() }
})

test('invalid URLs and line-injection fields are rejected before changing any settings', async () => {
  const f = await fixture(deepseek(secret))
  try {
    for (const baseUrl of ['https://user:password@service.invalid/v1', 'https://service.invalid/v1?key=value',
      'https://service.invalid/v1#fragment', 'https://service.invalid/v1?', 'https://service.invalid/v1#', 'http://remote.invalid/v1', 'file:///tmp/api', 'not-a-url']) {
      assert.throws(() => normalizeAIBaseUrl(baseUrl))
      await assert.rejects(f.store.save({ provider: 'custom', baseUrl, model: 'test' }))
    }
    for (const input of [null, { provider: 'unknown', model: 'test' }, { provider: 'deepseek', model: '' },
      { provider: 'deepseek', model: 'test\nINJECT=value' }, { provider: 'deepseek', model: 'test', apiKey: 'key\r\nINJECT=value' },
      { provider: 'deepseek', model: 'test', clearApiKey: 'true' }]) {
      await assert.rejects(f.store.save(input), error => !error.message.includes(secret))
    }
    assert.equal(await readFile(f.envFile, 'utf8'), deepseek(secret))
    assert.deepEqual(await readdir(f.dir), ['.env'])
  } finally { await f.cleanup() }
})

test('concurrent saves are serialized and reads observe the completed queue', async () => {
  const f = await fixture(deepseek(secret) + 'DEEPSEEK_MODEL=retained\n')
  try {
    const first = f.store.save({ provider: 'deepseek', model: 'model-one' })
    const second = f.store.save({ provider: 'deepseek', model: 'model-two', apiKey: 'second-test-key' })
    const reading = f.store.read()
    assert.equal((await first).model, 'model-one')
    assert.equal((await second).model, 'model-two')
    const final = await reading
    assert.equal(final.publicConfig.model, 'model-two')
    assert.equal(final.apiKey, 'second-test-key')
    assert.match(await readFile(f.envFile, 'utf8'), /DEEPSEEK_MODEL=retained/)
    assert.deepEqual(await readdir(f.dir), ['.env'])
  } finally { await f.cleanup() }
})

test('saving valid replacement fields can repair an invalid old target without reusing its key', async () => {
  const f = await fixture('OPENAI_BASE_URL=broken-target\nOPENAI_MODEL=old\nOPENAI_API_KEY=' + secret + '\nDEEPSEEK_MODEL=retained\n')
  try {
    await assert.rejects(f.store.read(), /服务地址无效/)
    const preview = await f.store.preview({ provider: 'deepseek', model: 'deepseek-flash' })
    assert.equal(preview.apiKey, '')
    const saved = await f.store.save({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'replacement-test-key' })
    assert.equal(saved.configured, true)
    assert.equal((await f.store.read()).apiKey, 'replacement-test-key')
    assert.match(await readFile(f.envFile, 'utf8'), /DEEPSEEK_MODEL=retained/)
  } finally { await f.cleanup() }
})


test('a BOM immediately before a managed assignment and missing final newline remain readable', async () => {
  const f = await fixture('\uFEFFOPENAI_BASE_URL=https://api.deepseek.com\nOPENAI_MODEL=old\nOPENAI_API_KEY=' + secret)
  try {
    await f.store.save({ provider: 'deepseek', model: 'deepseek-flash' })
    const text = await readFile(f.envFile, 'utf8')
    assert.equal(text[0], '\uFEFF')
    assert.equal((await f.store.read()).apiKey, secret)
    assert.equal((await f.store.read()).publicConfig.model, 'deepseek-flash')
  } finally { await f.cleanup() }
})
