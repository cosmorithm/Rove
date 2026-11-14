import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { importPdf, pdfScheme, servePdf } from './pdf'
import { registerCoding } from './coding'

app.setName('Rove')

// Keep the library, its file:// storage, and the Chromium profile from the original app.
const libraryDirectory = join(app.getPath('appData'), '知序')
mkdirSync(libraryDirectory, { recursive: true, mode: 0o700 })
app.setPath('userData', libraryDirectory)
app.setPath('sessionData', libraryDirectory)
// The macOS bundle retains Electron's executable name, so app.isPackaged
// cannot distinguish this build from a development launch.
const appRoot = app.getAppPath()
const loadedFromBundle = dirname(appRoot) === process.resourcesPath
const envFile = loadedFromBundle
  ? resolve(process.resourcesPath, '../../../.env')
  : join(appRoot, '.env')

async function readAIConfig() {
  let env: Record<string, string | undefined> = {}
  try {
    env = parseEnv((await readFile(envFile, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('无法读取项目的 .env，请检查文件格式和访问权限。')
    }
  }
  const baseUrl = env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'
  const model = env.OPENAI_MODEL?.trim() || ''
  const apiKey = env.OPENAI_API_KEY?.trim() || ''
  let endpoint: URL
  try {
    endpoint = new URL(baseUrl)
  } catch {
    throw new Error('.env 中的 OPENAI_BASE_URL 无效，请填写完整的服务地址。')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('服务地址只能包含协议、主机和路径，请使用 OPENAI_API_KEY 配置密钥。')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) {
    throw new Error('服务地址必须使用 HTTPS，本机服务可使用 HTTP。')
  }
  const configured = Boolean(model && (endpoint.hostname !== 'api.openai.com' || apiKey))
  const publicConfig = { baseUrl: endpoint.href.replace(/\/$/, ''), model, configured }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions'
  return { publicConfig, apiKey, endpoint }
}

protocol.registerSchemesAsPrivileged([{
  scheme: pdfScheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

let mainWindow: BrowserWindow | null = null

const rendererFile = join(__dirname, '../renderer/index.html')
const developmentUrl = !loadedFromBundle && process.env.ELECTRON_RENDERER_URL
const trustedUrl = developmentUrl || pathToFileURL(rendererFile).href

function requireReader(event: IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      new URL(event.senderFrame.url).href.split('#')[0] !== new URL(trustedUrl).href.split('#')[0]) {
    throw new Error('只有学习主窗口可以使用这个操作。')
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f7f7f5',
    title: 'Rove · 探索工作台',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.on('closed', () => { mainWindow = null })
  if (developmentUrl) void mainWindow.loadURL(developmentUrl)
  else void mainWindow.loadFile(rendererFile)
}

app.whenReady().then(() => {
  const pdfDirectory = join(app.getPath('userData'), 'pdfs')
  protocol.handle(pdfScheme, request => servePdf(request, pdfDirectory, trustedUrl))
  ipcMain.handle('pdf:open', async (event) => {
    requireReader(event)
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    try {
      return await importPdf(result.filePaths[0], pdfDirectory)
    } catch (error) {
      switch ((error as NodeJS.ErrnoException).code) {
        case 'ENOSPC':
        case 'EDQUOT': throw new Error('磁盘空间不足，请释放空间后重新导入。')
        case 'EACCES':
        case 'EPERM': throw new Error('无法读取文件或保存副本。请检查文件权限和 Rove 的文件访问权限后重试。')
        case 'ENOENT': throw new Error('未找到文件，请确认文件已下载到本机，并重新选择。')
        default: throw error
      }
    }
  })

  ipcMain.handle('ai:config', async event => {
    requireReader(event)
    return (await readAIConfig()).publicConfig
  })
  ipcMain.handle('ai:show-env', event => {
    requireReader(event)
    shell.showItemInFolder(envFile)
  })
  ipcMain.handle('ai:ask', async (event, request: unknown) => {
    requireReader(event)
    if (!request || typeof request !== 'object') throw new Error('请求无效。')
    const input = request as { question?: unknown; context?: unknown }
    const question = typeof input.question === 'string' ? input.question.trim().slice(0, 4000) : ''
    const context = typeof input.context === 'string' ? input.context.slice(0, 24000) : ''
    if (!question) throw new Error('请输入问题。')
    const { publicConfig: { model, configured }, endpoint, apiKey } = await readAIConfig()
    if (!configured) throw new Error('请在项目根目录的 .env 中填写模型名称和服务所需的密钥。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90000)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [
          { role: 'system', content: '你是一位耐心的中文自学导师。结合给定资料解释问题，简洁清晰；资料不足时明确说明，不要伪造来源。' },
          { role: 'user', content: `学习上下文：\n${context || '无'}\n\n问题：${question}` }
        ] }),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`模型服务请求失败（HTTP ${response.status}）。请检查服务地址、模型和密钥。`)
      const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型服务没有返回文本内容。')
      return content.trim()
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('模型请求超时，请重试。')
      if (error instanceof TypeError) throw new Error('无法连接模型服务，请检查地址和网络。')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })
  registerCoding({ ipcMain, window: () => mainWindow, requireReader, storageDir: libraryDirectory, envFile, appRoot })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
