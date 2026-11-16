import { constants } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'
import { aiProviders, type AIConfigDraft, type AIConfigPublic, type AIProtocol, type AIProviderId } from '../../src/aiSettingsTypes.ts'

export interface AIModelConfig {
  publicConfig: AIConfigPublic
  apiKey: string
  endpoint: URL
  protocol: AIProtocol
}

const names = ['ROVE_AI_PROVIDER', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_KEY'] as const

function preset(id: unknown) {
  const result = aiProviders.find(item => item.id === id)
  if (!result) throw new Error('请选择有效的模型厂商。')
  return result
}

function field(input: unknown, label: string, maxLength: number) {
  if (typeof input !== 'string' || input.length > maxLength || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error(label + '无效，请使用单行文本。')
  }
  return input.trim()
}

export function normalizeAIBaseUrl(input: string): string {
  const value = field(input, '服务地址', 8192)
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error('服务地址无效，请填写完整的基础地址。') }
  if (url.username || url.password || url.search || url.hash || /[?#]/u.test(value)) {
    throw new Error('服务地址只能包含协议、主机和路径，请在 API Key 栏中填写密钥。')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('服务地址必须使用 HTTPS，本机服务可使用 HTTP。')
  }
  return url.href.replace(/\/+$/, '')
}

function inferProvider(baseUrl: string): AIProviderId {
  const host = new URL(baseUrl).hostname
  return aiProviders.find(item => item.baseUrl && new URL(item.baseUrl).hostname === host)?.id ?? 'custom'
}

function resolved(provider: AIProviderId, baseUrl: string, model: string, apiKey: string): AIModelConfig {
  const definition = preset(provider)
  const endpoint = new URL(baseUrl)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + (definition.protocol === 'anthropic' ? '/messages' : '/chat/completions')
  return {
    publicConfig: { provider, baseUrl, model, hasApiKey: Boolean(apiKey),
      configured: Boolean(model && (!definition.requiresKey || apiKey)) },
    apiKey, endpoint, protocol: definition.protocol,
  }
}

function configFromEnv(env: Record<string, string | undefined>): AIModelConfig {
  const declared = aiProviders.find(item => item.id === env.ROVE_AI_PROVIDER?.trim())
  const baseUrl = normalizeAIBaseUrl(env.OPENAI_BASE_URL?.trim() || declared?.baseUrl || 'https://api.openai.com/v1')
  const provider = declared?.id ?? inferProvider(baseUrl)
  const model = field(env.OPENAI_MODEL ?? '', '模型名称', 512)
  const apiKey = field(env.OPENAI_API_KEY ?? '', 'API Key', 8192)
  return resolved(provider, baseUrl, model, apiKey)
}

function preview(input: AIConfigDraft, current: AIModelConfig): AIModelConfig {
  if (!input || typeof input !== 'object') throw new Error('模型配置无效。')
  const definition = preset(input.provider)
  const fallback = input.provider === current.publicConfig.provider ? current.publicConfig.baseUrl : definition.baseUrl
  const baseUrl = normalizeAIBaseUrl(input.baseUrl === undefined ? fallback : input.baseUrl)
  const model = field(input.model, '模型名称', 512)
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('密钥操作无效。')
  const supplied = input.apiKey === undefined ? '' : field(input.apiKey, 'API Key', 8192)
  const sameTarget = input.provider === current.publicConfig.provider && baseUrl === current.publicConfig.baseUrl
  const apiKey = supplied || (sameTarget && !input.clearApiKey ? current.apiKey : '')
  return resolved(definition.id, baseUrl, model, apiKey)
}

/** Node's dotenv parser has different escaping rules from JSON. Verify an exact round trip. */
function encodeEnvValue(name: string, value: string) {
  for (const candidate of ["'" + value + "'", '"' + value + '"', '`' + value + '`', value]) {
    const line = name + '=' + candidate
    const parsed = parseEnv(line)
    if (parsed[name] === value && Object.keys(parsed).length === 1) return candidate
  }
  throw new Error('配置包含无法保存在 .env 中的字符。')
}

/** Replace complete assignments, skipping any assignment-like lines inside quoted values. */
function updateEnv(original: string, values: Record<typeof names[number], string>) {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
  if (bom) original = original.slice(1)
  const expression = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*/gm
  const found = new Set<string>()
  let output = '', cursor = 0
  for (let match = expression.exec(original); match; match = expression.exec(original)) {
    const name = match[1]
    const valueStart = expression.lastIndex
    const quote = original[valueStart]
    const close = ["'", '"', '`'].includes(quote) ? original.indexOf(quote, valueStart + 1) : -1
    const newline = original.indexOf('\n', close < 0 ? valueStart : close + 1)
    const end = newline < 0 ? original.length : newline
    expression.lastIndex = end
    if (!names.includes(name as typeof names[number])) continue
    const lineEnd = end > valueStart && original[end - 1] === '\r' ? end - 1 : end
    const comment = original.indexOf('#', close < 0 ? valueStart : close + 1)
    const trailing = comment >= 0 && comment < lineEnd ? ' ' + original.slice(comment, lineEnd) : ''
    output += original.slice(cursor, match.index) + name + '=' + encodeEnvValue(name, values[name as typeof names[number]]) + trailing
    cursor = lineEnd
    found.add(name)
  }
  output += original.slice(cursor)
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  for (const name of names) {
    if (found.has(name)) continue
    if (output && !output.endsWith('\n')) output += newline
    output += name + '=' + encodeEnvValue(name, values[name]) + newline
  }
  const parsed = parseEnv(output.replace(/^\uFEFF/u, ''))
  if (names.some(name => parsed[name] !== values[name])) throw new Error('无法更新 .env 配置，原文件已保留。')
  return bom + output
}

export function createAIConfigStore(options: { envFile: string }) {
  let queue: Promise<unknown> = Promise.resolve()
  async function readText() {
    try { return await readFile(options.envFile, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new Error('无法读取项目的 .env，请检查访问权限。')
    }
  }
  function parse(text: string) {
    try { return configFromEnv(parseEnv(text.replace(/^\uFEFF/u, ''))) }
    catch (error) {
      // Validation errors intentionally contain no values or provider response bodies.
      if (error instanceof Error) throw error
      throw new Error('无法读取项目的 .env，请检查文件格式。')
    }
  }
  function priorForDraft(text: string) {
    try { return parse(text) }
    catch {
      // A valid replacement can repair an invalid old configuration. Its key must be re-entered.
      return resolved('custom', 'https://api.openai.com/v1', '', '')
    }
  }
  return {
    async read(): Promise<AIModelConfig> {
      await queue
      return parse(await readText())
    },
    async preview(input: AIConfigDraft): Promise<AIModelConfig> {
      await queue
      return preview(input, priorForDraft(await readText()))
    },
    save(input: AIConfigDraft): Promise<AIConfigPublic> {
      // Copy renderer-owned input before entering the write queue.
      const draft = input && typeof input === 'object' ? { ...input } : input
      const operation = queue.then(async () => {
        const original = await readText()
        const config = preview(draft, priorForDraft(original))
        if (!config.publicConfig.model) throw new Error('请选择或填写模型名称。')
        const values = { ROVE_AI_PROVIDER: config.publicConfig.provider, OPENAI_BASE_URL: config.publicConfig.baseUrl,
          OPENAI_MODEL: config.publicConfig.model, OPENAI_API_KEY: config.apiKey }
        const updated = updateEnv(original, values)
        await mkdir(dirname(options.envFile), { recursive: true })
        const temp = join(dirname(options.envFile), '.env.' + randomUUID() + '.tmp')
        try {
          const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
          try { await file.writeFile(updated); await file.sync() }
          finally { await file.close() }
          if (await readText() !== original) throw new Error('配置文件在保存期间发生变化，请重试。')
          await rename(temp, options.envFile)
        } catch (error) {
          if (error instanceof Error && error.message === '配置文件在保存期间发生变化，请重试。') throw error
          throw new Error('无法保存 .env，请检查目录权限和磁盘空间。')
        } finally { await rm(temp, { force: true }) }
        return parse(await readText()).publicConfig
      })
      queue = operation.then(() => undefined, () => undefined)
      return operation
    },
  }
}
