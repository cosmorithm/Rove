import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import type { CodeEngine } from '../../src/codingTypes'

interface EnginePaths { envFile: string; appRoot: string; storageDir: string; resourcesPath: string }
interface RunOptions { cwd: string; prompt: string; kind: 'ask' | 'edit'; signal: AbortSignal; onProgress(message: string): void }

const official = 'https://api.deepseek.com/anthropic'
const isOfficial = (url: URL) => url.origin === 'https://api.deepseek.com'

async function config(envFile: string) {
  let file: NodeJS.Dict<string> = {}
  try { file = parseEnv((await readFile(envFile, 'utf8')).replace(/^\uFEFF/, '')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  const get = (key: string) => (file[key] ?? process.env[key] ?? '').trim()
  const endpoint = new URL(get('DEEPSEEK_BASE_URL') || official)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) {
    throw new Error('请检查 .env 中的 DEEPSEEK_BASE_URL，填写 HTTPS 或本机 Messages 服务地址。')
  }
  if (isOfficial(endpoint) && ['/', '/v1', '/v1/'].includes(endpoint.pathname)) endpoint.pathname = '/anthropic'
  let key = get('DEEPSEEK_API_KEY')
  if (!key && isOfficial(endpoint)) {
    // Pair legacy credentials with the endpoint from the same source, so an
    // unrelated inherited OpenAI key cannot fill a half-configured .env.
    const legacy = file.OPENAI_BASE_URL !== undefined || file.OPENAI_API_KEY !== undefined ? file : process.env
    try { if (isOfficial(new URL(legacy.OPENAI_BASE_URL ?? ''))) key = (legacy.OPENAI_API_KEY ?? '').trim() }
    catch { /* A missing or unrelated OpenAI endpoint does not supply a DeepSeek key. */ }
  }
  return { key, baseURL: endpoint.href.replace(/\/+$/, ''), model: get('DEEPSEEK_MODEL') }
}

function runtimePath(paths: EnginePaths) {
  return [join(paths.resourcesPath, 'dsh-runtime'), paths.appRoot]
}
async function runtime(paths: EnginePaths) {
  let missingNode = false
  for (const root of runtimePath(paths)) {
    const folder = join(root, 'node_modules/@deepseek-ai/dsh')
    const entry = join(folder, 'lib/bin.js')
    try {
      const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
      if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string') continue
      await access(entry)
      let executable = join(root, 'node_modules/node/bin/node')
      try { await access(executable, constants.X_OK) }
      catch {
        // DSH's native host supports standalone Node, not Electron's embedded V8.
        // Tests and Node-based development can use their own Node executable.
        if (process.versions.electron) { missingNode = true; continue }
        executable = process.execPath
      }
      return { entry, executable, version: manifest.version as string,
        binPaths: [join(root, 'bin'), dirname(executable), join(root, 'node_modules/.bin')] }
    } catch { /* Check both the bundled and development dependency locations. */ }
  }
  if (missingNode) throw new Error('未找到 DSH 的独立 Node 运行时，请重新安装 Rove 的项目依赖或应用。')
  throw new Error('未找到 DeepSeek Harness 运行时，请重新安装 Rove 的项目依赖或应用。')
}

type Settings = Awaited<ReturnType<typeof config>>
type Runtime = Awaited<ReturnType<typeof runtime>>
function childEnv(home: string, settings: Settings, host: Runtime) {
  // Do not pass unrelated provider keys, user Node loaders, or app secrets to tools.
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE','USER','LOGNAME','SHELL','TERM','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY','http_proxy','https_proxy','no_proxy','all_proxy','SSL_CERT_FILE','SSL_CERT_DIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, PATH: [...host.binPaths, env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(delimiter),
    DSH_HOME: home, DEEPSEEK_API_KEY: settings.key, DEEPSEEK_BASE_URL: settings.baseURL }
}
function displayError(message: string, key: string) {
  return message.replaceAll(key, '[密钥已省略]').replace(/(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,})/g, '[密钥已省略]').slice(0, 1000)
}

async function invoke(host: Runtime, home: string, patch: string, settings: Settings, options: RunOptions) {
  const args = [host.entry, 'headless', '--patch', patch, '--permission-mode', options.kind === 'ask' ? 'read-only' : 'workspace-write',
    '--approval-policy', 'never', '--json', '-']
  const child = spawn(host.executable, args, { cwd: options.cwd, env: childEnv(home, settings, host), shell: false,
    detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let final: { text: string; reason: string } | undefined
  let protocolError = '', line = '', diagnostic = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  function kill(signal: NodeJS.Signals) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
  }
  function cancel() {
    kill('SIGTERM')
    timer ??= setTimeout(() => kill('SIGKILL'), 3000)
  }
  const onExit = () => kill('SIGKILL')
  function parse(raw: string) {
    if (!raw.trim() || protocolError) return
    let e
    try { e = JSON.parse(raw) } catch { protocolError = 'DSH 返回了无效的 JSON 事件。'; cancel(); return }
    if (!e || typeof e !== 'object') return
    if (e.type === 'session') options.onProgress('DSH 会话已启动。')
    if (e.type === 'status' && e.phase === 'step_start') options.onProgress('DSH 正在处理任务…')
    if (e.type === 'tool_call') options.onProgress('DSH 正在调用工具' + (typeof e.tool === 'string' && /^[\w.-]{1,64}$/.test(e.tool) ? ' ' + e.tool : '') + '。')
    if (e.type === 'tool_result') options.onProgress(e.status === 'error' ? '工具返回错误。' : '工具执行完毕。')
    if (e.type === 'error' && typeof e.message === 'string') diagnostic = displayError(e.message, settings.key)
    if (e.type === 'final' && typeof e.text === 'string') final = { text: e.text, reason: e.reason?.kind }
  }
  const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (protocolError) return
    line += chunk
    for (let end = line.indexOf('\n'); end >= 0; end = line.indexOf('\n')) {
      parse(line.slice(0, end)); line = line.slice(end + 1)
    }
    if (line.length > 16 * 1024 * 1024) { line = ''; protocolError = 'DSH 返回的单条事件超过 16 MiB。'; cancel() }
  })
  let errTail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { errTail = (errTail + chunk).slice(-6000) })
  child.stdin.on('error', () => {})
  options.signal.addEventListener('abort', cancel, { once: true })
  process.once('exit', onExit)
  if (options.signal.aborted) cancel()
  try {
    child.stdin.end(options.prompt)
    const code = await completion
    if (line) parse(line)
    if (options.signal.aborted) return { answer: final?.text || '已停止 DSH，当前代码状态已保留。', cancelled: true }
    if (protocolError) throw new Error(protocolError)
    if (code !== 0 || final?.reason !== 'completed') {
      const safe = diagnostic || displayError(errTail.split(/\r?\n/).reverse().find(s => /^dsh:/i.test(s)) || '', settings.key)
      throw new Error('DSH 未完成任务' + (safe ? '：' + safe : '（' + (final?.reason || '退出码 ' + code) + '）。'))
    }
    return { answer: final.text, cancelled: false }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', cancel)
    process.removeListener('exit', onExit)
  }
}

export function createHarnessEngine(paths: EnginePaths) {
  const home = join(paths.storageDir, 'coding', 'dsh')
  async function engine(): Promise<CodeEngine> {
    let version: string
    try { version = (await runtime(paths)).version }
    catch (error) { return { available: false, authenticated: false, version: '', message: (error as Error).message } }
    try {
      const settings = await config(paths.envFile)
      return { available: true, version, authenticated: Boolean(settings.key),
        message: settings.key ? 'DeepSeek Harness 已配置' : '请在 Rove 的 .env 中填写 DEEPSEEK_API_KEY。' }
    } catch (error) { return { available: true, authenticated: false, version, message: (error as Error).message } }
  }
  async function runHarness(options: RunOptions) {
    if (options.signal.aborted) return { answer: '已停止 DSH。', cancelled: true }
    const host = await runtime(paths)
    const settings = await config(paths.envFile)
    if (!settings.key) throw new Error('请在 Rove 的 .env 中填写 DEEPSEEK_API_KEY。')
    await mkdir(home, { mode: 0o700, recursive: true })
    const dir = await mkdtemp(join(home, 'run-'))
    try {
      const rows = [{ id: 'session-log-deepseek', config: { enabled: false } } as {id: string; config: Record<string, unknown>}]
      if (settings.model) rows.push({ id: 'agent-default-model', config: { provider: 'deepseek-official', model: settings.model } })
      const patch = join(dir, 'settings.yml')
      // Each item is a JSON mapping in a YAML sequence; configuration values stay data.
      await writeFile(patch, rows.map(row => '- ' + JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
      return await invoke(host, home, patch, settings, options)
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  return { engine, runHarness }
}
