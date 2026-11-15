import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { CodeProgress, CodeRunRequest, CodeRunResult, CodeTraceInfo, CodeTraceRecord, CodeWorkspace } from '../../src/codingTypes'
import { CodingStore } from './codingCore'
import { createHarnessEngine, sanitizeHarnessEvent } from './codingEngine'
import { CodingTraceStore } from './codingTrace'

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
  const traces = new CodingTraceStore(join(options.storageDir, 'coding'))
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
  handle('fork', async value => {
    const p = args(value)
    const id = workspaceId(p.workspaceId)
    const commit = optional(p.commit, '版本', 64), label = optional(p.label, '名称', 512)
    const workspace = await store.workspace(id)
    const win = options.window()
    if (!win) return null
    const chosen = await dialog.showOpenDialog(win, {
      title: '选择一个空文件夹作为分支工作区', buttonLabel: '在此创建分支',
      defaultPath: workspace.path, properties: ['openDirectory', 'createDirectory']
    })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return store.fork(id, chosen.filePaths[0], commit, label)
  })
  handle('trace', async value => {
    const p = args(value)
    const id = workspaceId(p.workspaceId), nodeId = text(p.nodeId, '问题编号', 128)
    const after = p.after === undefined ? 0 : p.after
    const limit = p.limit === undefined ? 100 : p.limit
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 ||
        typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('记录分页参数无效。')
    const archived = await store.readTrace(id, nodeId, after, limit)
    if (archived.available) return archived
    const live = await traces.read(nodeId, after, limit)
    return { ...live, partial: live.available && !activeNodes.has(nodeId) && !live.complete }
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
    let latestMessage = '正在准备工作区…'
    const progress = (message: string, before?: string, record?: CodeTraceRecord) => {
      latestMessage = message
      if (!event.sender.isDestroyed()) {
        try { event.sender.send('coding:progress', { runId: input.runId, message, before, record } satisfies CodeProgress) }
        catch { /* A closing renderer must not prevent durable task records. */ }
      }
    }
    try {
      const workspace = await store.workspace(input.workspaceId)
      const existing = await store.existingTurn(workspace, nodeId)
      if (existing) return existing
      return await store.locking(workspace.id, async (target: CodeWorkspace) => {
        const before = await store.snapshot(target, 'Rove · 运行前')
        progress('已保存运行前版本。', before)
        let answer = '', cancelled = controller.signal.aborted, executionError: unknown
        let journal: Awaited<ReturnType<CodingTraceStore['start']>> | undefined
        let trace: CodeTraceInfo | undefined, traceIncomplete = false
        const append = async (record: Record<string, unknown>) => {
          if (!journal) throw new Error('运行记录尚未创建。')
          const saved = await journal.append(sanitizeHarnessEvent(record, ''))
          progress(latestMessage, undefined, saved)
        }
        try {
          journal = await traces.start({ runId: input.runId, nodeId })
          await append({ type: 'run_started', source: 'rove', workspaceId: target.id, workspace: target.path,
            kind: input.kind, before, parentCommit: input.parentCommit, prompt: input.prompt, context: input.context,
            sequence: 'receipt-order' })
          if (!cancelled) {
            const parentRecords = input.parentCommit ? '\n上层对话 Git 节点：' + input.parentCommit +
              '。核对祖先工具调用时，可用 git show -s --format=%b <节点提交> 查看 trace.blob，' +
              '再用 git cat-file blob <blob> 按需读取原始事件；沿 Git 父提交可以继续查找祖先。' : ''
            const response = await runHarness({
              kind: input.kind, cwd: target.path, signal: controller.signal,
              prompt: '当前工作区：' + target.path + '\n本次运行前代码快照：' + before +
                '\n' + (input.kind === 'edit' ? '本轮直接在当前工作区完成要求的文件修改。' : '本轮只读，在当前工作区查看代码并回答。') +
                '对话路径是历史参考，当前工作区文件是本次执行的代码。Git 记录由 Rove 保存。' + parentRecords + '\n\n' +
                (input.context ? '已有讨论与选中材料：\n' + input.context + '\n\n' : '') + '本次请求：\n' + input.prompt,
              onProgress: message => progress(message), onEvent: append
            })
            answer = response.answer
            cancelled = response.cancelled || controller.signal.aborted
          }
        } catch (error) {
          cancelled = controller.signal.aborted
          executionError = error
        }
        if (executionError && !cancelled) {
          const reason = executionError instanceof Error ? executionError.message : '任务异常结束。'
          answer = 'DSH 运行失败：' + reason
          progress(answer)
        }
        if (cancelled && !answer) answer = '已停止运行。'
        const outcome = () => cancelled ? 'cancelled' as const : executionError ? 'failed' as const : 'completed' as const
        if (journal) {
          try { await append({ type: 'run_finished', source: 'rove', outcome: outcome(), answer, before }) }
          catch (error) {
            traceIncomplete = true
            executionError = error
            answer += '\n\n运行记录未能完整保存：' + (error instanceof Error ? error.message : '写入失败。')
          }
          try {
            const closed = await journal.close()
            trace = await store.archiveTrace(target, nodeId, closed)
            if (traceIncomplete) trace.partial = true
          } catch (error) {
            executionError = error
            answer += '\n\n运行记录归档失败：' + (error instanceof Error ? error.message : '无法归档。')
          }
        }
        const after = await store.turn(target, input.parentCommit || before, {
          before, runId: input.runId, nodeId, kind: input.kind,
          prompt: input.prompt, context: input.context, answer, outcome: outcome(), trace
        })
        const status = await store.status(target.id)
        return { answer, cancelled, before, after, status, trace }
      })
    } finally {
      event.sender.removeListener('destroyed', cancel)
      tasks.delete(input.runId)
      activeNodes.delete(nodeId)
    }
  })
}
