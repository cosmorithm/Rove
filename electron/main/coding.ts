import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { CodeProgress, CodeRunRequest, CodeRunResult, CodeWorkspace } from '../../src/codingTypes'
import { CodingStore } from './codingCore'
import { createHarnessEngine } from './codingEngine'

type Options = {
  ipcMain: IpcMain
  window: () => BrowserWindow | null
  requireReader: (event: IpcMainInvokeEvent) => void
  storageDir: string
  envFile: string
  appRoot: string
}

function text(value: unknown, label: string, max: number, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) {
    throw new Error(label + '无效。')
  }
  return value
}
function optional(value: unknown, label: string, max: number) {
  return value === undefined ? undefined : text(value, label, max)
}
function args(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数无效。')
  return value as Record<string, unknown>
}
const workspaceId = (value: unknown) => text(value, '工作区', 100)

export function registerCoding(options: Options) {
  const { engine, runHarness } = createHarnessEngine({ ...options, resourcesPath: process.resourcesPath })
  const store = new CodingStore(join(options.storageDir, 'coding'))
  const tasks = new Map<string, AbortController>()
  const activeNodes = new Set<string>()
  const handle = (name: string, action: (value: unknown, sender: IpcMainInvokeEvent) => unknown) => {
    options.ipcMain.handle('coding:' + name, (event, value) => {
      options.requireReader(event)
      return action(value, event)
    })
  }
  handle('list-projects', () => store.listProjects())
  handle('open-project', async () => {
    const win = options.window()
    if (!win) return null
    const chosen = await dialog.showOpenDialog(win, { title: '打开项目文件夹', properties: ['openDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return store.importProject(chosen.filePaths[0])
  })
  handle('engine', () => engine())
  handle('status', id => store.status(workspaceId(id)))
  handle('read-file', value => {
    const p = args(value)
    return store.read(workspaceId(p.workspaceId), text(p.path, '路径', 8192), optional(p.revision, '版本', 64))
  })
  handle('save-file', value => {
    const p = args(value)
    return store.save(workspaceId(p.workspaceId), text(p.path, '路径', 8192), text(p.content, '文本', 4 * 1024 * 1024, true), text(p.expectedHash, '文件签名', 64))
  })
  handle('diff', value => {
    const p = args(value)
    return store.diff(workspaceId(p.workspaceId), optional(p.from, '起始版本', 64), optional(p.to, '目标版本', 64))
  })
  handle('checkpoint', value => {
    const p = args(value)
    return store.checkpoint(workspaceId(p.workspaceId), text(p.message, '提交说明', 4000))
  })
  handle('fork', value => {
    const p = args(value)
    return store.fork(workspaceId(p.workspaceId), optional(p.commit, '版本', 64), optional(p.label, '名称', 512))
  })
  handle('cancel', value => { tasks.get(text(value, '运行编号', 128))?.abort() })
  handle('run', async (value, event): Promise<CodeRunResult> => {
    const p = args(value)
    if (p.kind !== 'ask' && p.kind !== 'edit') throw new Error('未知的代码操作。')
    const input: CodeRunRequest = { runId: text(p.runId, '运行编号', 128), workspaceId: workspaceId(p.workspaceId),
      kind: p.kind, prompt: text(p.prompt, '问题', 100_000), context: text(p.context, '上下文', 500_000, true),
      parentCommit: optional(p.parentCommit, '上层代码版本', 64), nodeId: optional(p.nodeId, '问题编号', 128) }
    const nodeId = input.nodeId ?? input.runId
    if (tasks.has(input.runId) || activeNodes.has(nodeId)) throw new Error('此任务已在运行。')
    const controller = new AbortController()
    tasks.set(input.runId, controller)
    activeNodes.add(nodeId)
    const cancel = () => controller.abort()
    event.sender.once('destroyed', cancel)
    const progress = (message: string, before?: string) => {
      if (!event.sender.isDestroyed()) event.sender.send('coding:progress', { runId: input.runId, message, before } satisfies CodeProgress)
    }
    try {
      let workspace = await store.workspace(input.workspaceId)
      const existing = await store.existingTurn(workspace, nodeId)
      if (existing) return existing
      if (input.kind === 'edit' && workspace.isMain) {
        progress('正在创建独立工作区…')
        workspace = await store.fork(workspace.id, input.parentCommit, input.prompt.slice(0, 60))
      }
      return await store.locking(workspace.id, async (target: CodeWorkspace) => {
        const before = await store.snapshot(target, 'Rove · 运行前')
        progress('已保存运行前版本。', before)
        let answer = '', cancelled = controller.signal.aborted, executionError: unknown
        if (!cancelled) {
          try {
            const response = await runHarness({
              kind: input.kind, cwd: target.path, signal: controller.signal,
              prompt: (input.context ? '已有讨论：\n' + input.context + '\n\n' : '') + '本次请求：\n' + input.prompt,
              onProgress: message => progress(message)
            })
            answer = response.answer
            cancelled = response.cancelled || controller.signal.aborted
          } catch (error) {
            cancelled = controller.signal.aborted
            executionError = error
          }
        }
        if (executionError && !cancelled) {
          const reason = executionError instanceof Error ? executionError.message : '任务异常结束。'
          answer = 'DSH 运行失败：' + reason
          progress(answer)
        }
        if (cancelled && !answer) answer = '已停止运行。'
        const after = await store.turn(target, input.parentCommit || before, {
          before, runId: input.runId, nodeId, kind: input.kind,
          prompt: input.prompt, context: input.context, answer,
          outcome: cancelled ? 'cancelled' : executionError ? 'failed' : 'completed'
        })
        const status = await store.status(target.id)
        return { answer, cancelled, before, after, status }
      })
    } finally {
      event.sender.removeListener('destroyed', cancel)
      tasks.delete(input.runId)
      activeNodes.delete(nodeId)
    }
  })
}
