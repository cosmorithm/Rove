import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CodeTracePage, CodeTraceRecord } from '../../src/codingTypes'

export interface ClosedCodeTrace {
  path: string; events: number; bytes: number; sha256: string; runId: string; nodeId: string
}
interface TraceInspection { events: number; bytes: number; sha256: string; last?: CodeTraceRecord }

export function validateTraceId(id: string, label = '运行节点') {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error(label + '无效。')
  return id
}
export function traceKey(nodeId: string) {
  return createHash('sha256').update(validateTraceId(nodeId)).digest('hex')
}
export function validateTracePageArgs(after: number, limit: number) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('运行记录分页参数无效。')
  }
}

function parseRecord(line: string, nodeId: string, expected: number): CodeTraceRecord {
  let record: CodeTraceRecord
  try { record = JSON.parse(line) } catch { throw new Error('运行记录包含损坏的 JSON，原文件已保留。') }
  if (!record || record.version !== 1 || record.seq !== expected || record.nodeId !== nodeId ||
      typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) ||
      !record.event || typeof record.event !== 'object' || Array.isArray(record.event)) {
    throw new Error('运行记录格式或序号无效，原文件已保留。')
  }
  validateTraceId(record.runId, '运行编号')
  return record
}

async function regularReader(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error('运行记录不是普通文件。')
    return file
  } catch (error) { await file.close(); throw error }
}

// JSONL is streamed, including for multi-megabyte tool results. Only the selected
// page and one unfinished line are retained in memory.
async function scanTrace(path: string, nodeId: string, visit?: (record: CodeTraceRecord) => boolean, live = false) {
  const file = await regularReader(path)
  const stream = file.createReadStream({ autoClose: false })
  const hash = createHash('sha256')
  let line = '', events = 0, bytes = 0, last: CodeTraceRecord | undefined, stopped = false, incompleteUtf8 = false
  // A streaming decoder preserves Unicode across arbitrary filesystem chunks.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      bytes += buffer.length
      hash.update(buffer)
      line += decoder.decode(buffer, { stream: true })
      for (let end = line.indexOf('\n'); end >= 0; end = line.indexOf('\n')) {
        const raw = line.slice(0, end)
        line = line.slice(end + 1)
        last = parseRecord(raw, nodeId, ++events)
        if (visit?.(last) === false) { stopped = true; break }
      }
      if (stopped) break
    }
    if (!stopped) {
      try { line += decoder.decode() }
      catch (error) { if (!live) throw error; incompleteUtf8 = true }
      if (line && !live) throw new Error('运行记录末尾未写完，原文件已保留。')
    }
    return { events, bytes, sha256: hash.digest('hex'), last, stopped, incomplete: !stopped && (!!line || incompleteUtf8) }
  } finally { stream.destroy(); await file.close() }
}

export async function inspectCodeTrace(path: string, nodeId: string): Promise<TraceInspection> {
  validateTraceId(nodeId)
  return scanTrace(path, nodeId)
}

export async function readTraceFilePage(path: string, nodeId: string, after = 0, limit = 100, live = false): Promise<CodeTracePage> {
  validateTraceId(nodeId)
  validateTracePageArgs(after, limit)
  const records: CodeTraceRecord[] = []
  let more = false
  try {
    const result = await scanTrace(path, nodeId, record => {
      if (record.seq <= after) return true
      if (records.length === limit) { more = true; return false }
      records.push(record)
      return true
    }, live)
    return { records, next: records.at(-1)?.seq ?? after, done: !more && !result.incomplete, available: true,
      ...(!result.stopped && !result.incomplete ? { complete: result.last?.event.type === 'run_finished' } : {}) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], next: after, done: true, available: false }
    throw error
  }
}

async function takeLock(path: string) {
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
        await handle.sync()
      } catch (error) {
        await rm(path, { force: true }).catch(() => {})
        throw error
      } finally { await handle.close() }
      return async () => {
        const lock = await regularReader(path)
        try {
          const value = JSON.parse(await lock.readFile('utf8'))
          if (value.token === token) await rm(path)
        } finally { await lock.close() }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const file = await regularReader(path)
      let pid: number, stat
      try {
        stat = await file.stat()
        const value = JSON.parse(await file.readFile('utf8'))
        pid = value.pid
        if (!Number.isSafeInteger(pid) || pid <= 0 || typeof value.token !== 'string') throw new Error('运行记录锁无效，请保留文件并检查上次运行。')
      } finally { await file.close() }
      let stale = false
      try { process.kill(pid, 0) }
      catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH' }
      if (!stale) throw new Error('此节点的运行记录仍在写入。')
      const current = await lstat(path)
      if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) throw new Error('运行记录锁已变化，请稍后重试。')
      await rm(path)
    }
  }
  throw new Error('无法锁定运行记录。')
}

export class CodingTraceStore {
  private directory: string
  private active = new Map<string, { idle(): Promise<void> }>()
  constructor(directory: string) { this.directory = resolve(directory, 'runs') }

  async start(ids: { runId: string; nodeId: string }) {
    const runId = validateTraceId(ids.runId, '运行编号'), nodeId = validateTraceId(ids.nodeId)
    const key = traceKey(nodeId)
    if (this.active.has(key)) throw new Error('此节点的运行记录仍在写入。')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (await realpath(this.directory) !== this.directory) throw new Error('运行记录目录发生变化。')
    const path = join(this.directory, key + '.jsonl')
    const release = await takeLock(path + '.lock')
    let handle!: FileHandle
    try {
      handle = await open(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      if (!(await handle.stat()).isFile()) throw new Error('运行记录不是普通文件。')
      await handle.chmod(0o600)
      const prior = await inspectCodeTrace(path, nodeId)
      let sequence = prior.events, tail = Promise.resolve(), writeError: unknown
      let closing = false, closed: Promise<ClosedCodeTrace> | undefined
      const state = { idle: () => tail }
      this.active.set(key, state)
      const append = (event: Record<string, unknown>): Promise<CodeTraceRecord> => {
        if (closing) return Promise.reject(new Error('运行记录已关闭。'))
        let payload = '', invalid: unknown
        try {
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('运行事件无效。')
          payload = JSON.stringify(event)
          if (!payload || payload[0] !== '{') throw new Error('运行事件无效。')
        } catch (error) { invalid = error }
        const task = tail.then(async () => {
          if (writeError) throw writeError
          if (invalid) { writeError = invalid; throw invalid }
          const record: CodeTraceRecord = { version: 1, seq: sequence + 1, at: new Date().toISOString(), runId, nodeId, event: JSON.parse(payload) }
          try {
            await handle.writeFile(JSON.stringify(record) + '\n')
            await handle.sync()
            sequence++
            return record
          } catch (error) { writeError = error; throw error }
        })
        // The returned task rejects for callers; the internal queue retains an
        // observed error state without an unhandled rejection or dropped writes.
        tail = task.then(() => {}, () => {})
        return task
      }
      const close = (): Promise<ClosedCodeTrace> => {
        if (closed) return closed
        closing = true
        closed = (async () => {
          try {
            await tail
            await handle.sync()
            await handle.close()
            const summary = await inspectCodeTrace(path, nodeId)
            return { path, events: summary.events, bytes: summary.bytes, sha256: summary.sha256, runId, nodeId }
          } finally {
            await handle.close().catch(() => {})
            if (this.active.get(key) === state) this.active.delete(key)
            await release()
          }
        })()
        return closed
      }
      return { append, close }
    } catch (error) {
      await handle?.close().catch(() => {})
      await release()
      throw error
    }
  }

  async read(nodeId: string, after = 0, limit = 100) {
    validateTracePageArgs(after, limit)
    const key = traceKey(nodeId), active = this.active.get(key)
    if (active) await active.idle()
    return readTraceFilePage(join(this.directory, key + '.jsonl'), nodeId, after, limit, !!active)
  }
}
