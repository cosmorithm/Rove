import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PreparedStudyContext, PrepareStudyContextRequest, StudyContextSelection,
  StudySummaryCache, StudySummaryLevel, StudyTurnMetadata, StudyTurnSource, StudyTurnVersion,
} from '../../src/studyContextTypes'

export type StudySummarizer = (source: StudyTurnSource) => Promise<{
  L0: string; L1: string; L2: string; model?: string; inputTruncated?: boolean; outputTruncated?: boolean
}>
export type StudySummaryGenerator = StudySummarizer

const maxContext = 24_000
const maxText = 1_000_000
const levels = ['L0', 'L1', 'L2'] as const
function hasSummary(version: StudyTurnVersion | undefined, level: StudySummaryLevel) {
  const value = version?.summaries[level]?.text
  return typeof value === 'string' && Boolean(value.trim()) &&
    (level !== 'L0' || (value.length <= 32 && !/[\r\n]/u.test(value)))
}
function id(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(label + '无效。')
  return value
}
function text(value: unknown, label: string, empty = false, limit = maxText) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (!empty && !value.trim())) {
    throw new Error(label + '无效。')
  }
  return value
}
function answerVersion(value: unknown) {
  if (value !== undefined && value !== 'original' && value !== 'edited') throw new Error('回答版本无效。')
  return value as 'original' | 'edited' | undefined
}
function selection(input: StudyContextSelection): StudyContextSelection {
  if (!input || !Number.isSafeInteger(input.depth) || input.depth < 0 || input.depth > 100 ||
      !levels.includes(input.level)) throw new Error('请选择有效的回溯层数和摘要级别。')
  return { depth: input.depth, level: input.level }
}
function source(input: StudyTurnSource): StudyTurnSource {
  if (!input || typeof input !== 'object' || !input.document || typeof input.document !== 'object') throw new Error('对话元数据无效。')
  const nodeId = id(input.nodeId, '对话节点')
  const parentId = input.parentId === undefined ? undefined : id(input.parentId, '父节点')
  if (parentId === nodeId) throw new Error('对话节点不能继承自己。')
  if (input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1)) throw new Error('原文页码无效。')
  if (input.outcome !== undefined && !['completed', 'failed', 'demo'].includes(input.outcome)) throw new Error('对话状态无效。')
  // Fixed field order makes revisions independent of object key insertion order.
  return {
    nodeId, ...(parentId ? { parentId } : {}),
    question: text(input.question, '问题'), answer: text(input.answer, '回答', true),
    ...(input.answerVersion !== undefined ? { answerVersion: answerVersion(input.answerVersion) } : {}),
    ...(input.excerpt !== undefined ? { excerpt: text(input.excerpt, '引用内容', true) } : {}),
    ...(input.excerptVersion !== undefined ? { excerptVersion: answerVersion(input.excerptVersion) } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    document: {
      id: id(input.document.id, '对话或资料编号'), name: text(input.document.name, '对话或资料名称', false, 8192),
      blockId: id(input.document.blockId, '话题编号'), title: text(input.document.title, '话题标题', true, 8192),
    },
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
  }
}
function revision(input: StudyTurnSource) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}
function safeSlice(value: string, length: number) {
  let end = Math.max(0, Math.min(length, value.length))
  if (end && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--
  return value.slice(0, end)
}
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2000) }

export class StudyContextStore {
  private directory: string
  private summarize: StudySummarizer
  private queues = new Map<string, Promise<unknown>>()
  private pending = new Map<string, Promise<void>>()

  constructor(directory: string, summarize: StudySummarizer) {
    this.directory = directory
    this.summarize = summarize
  }
  private path(nodeId: string) {
    return join(this.directory, createHash('sha256').update(id(nodeId, '对话节点')).digest('hex') + '.json')
  }
  private async load(nodeId: string): Promise<StudyTurnMetadata | null> {
    let file
    try { file = await open(this.path(nodeId), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    try {
      if (!(await file.stat()).isFile()) throw new Error('对话元数据不是普通文件。')
      const metadata = JSON.parse(await file.readFile('utf8')) as StudyTurnMetadata
      if (metadata.version !== 1 || metadata.nodeId !== nodeId || !Array.isArray(metadata.versions)) {
        throw new Error('对话元数据格式无效，原文件已保留。')
      }
      for (const item of metadata.versions) {
        const normalized = source(item.source)
        if (normalized.nodeId !== nodeId || revision(normalized) !== item.revision ||
            !['pending', 'ready', 'failed'].includes(item.state) || !item.summaries || typeof item.summaries !== 'object') {
          throw new Error('对话版本校验失败，原文件已保留。')
        }
      }
      return metadata
    } finally { await file.close() }
  }
  private async write(metadata: StudyTurnMetadata) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = this.path(metadata.nodeId) + '.' + randomUUID()
    const file = await open(temp, 'wx', 0o600)
    try {
      try { await file.writeFile(JSON.stringify(metadata)); await file.sync() }
      finally { await file.close() }
      await rename(temp, this.path(metadata.nodeId))
    } finally { await rm(temp, { force: true }) }
  }
  private mutate<T>(nodeId: string, change: (metadata: StudyTurnMetadata) => Promise<T> | T): Promise<T> {
    id(nodeId, '对话节点')
    const prior = this.queues.get(nodeId) ?? Promise.resolve()
    const operation = prior.then(async () => {
      const metadata = await this.load(nodeId) ?? { version: 1 as const, nodeId, createdAt: new Date().toISOString(), versions: [] }
      const result = await change(metadata)
      await this.write(metadata)
      return result
    })
    const settled = operation.then(() => undefined, () => undefined)
    this.queues.set(nodeId, settled)
    void settled.then(() => { if (this.queues.get(nodeId) === settled) this.queues.delete(nodeId) })
    return operation
  }
  async get(nodeId: string): Promise<StudyTurnMetadata | null> {
    id(nodeId, '对话节点')
    await this.queues.get(nodeId)
    return this.load(nodeId)
  }
  async save(input: StudyTurnSource): Promise<StudyTurnMetadata> {
    let normalized = source(input)
    let rev = ''
    const ready = await this.mutate(normalized.nodeId, metadata => {
      if (metadata.parentId && !normalized.parentId) normalized = source({ ...normalized, parentId: metadata.parentId })
      if (metadata.parentId && metadata.parentId !== normalized.parentId) throw new Error('同一对话节点的父节点不能改变。')
      metadata.parentId ??= normalized.parentId
      rev = revision(normalized)
      const existing = metadata.versions.find(item => item.revision === rev)
      if (existing?.state === 'ready' && levels.every(level => hasSummary(existing, level))) return true
      if (existing) { existing.state = 'pending'; delete existing.error }
      else metadata.versions.push({ revision: rev, source: normalized, createdAt: new Date().toISOString(), state: 'pending', summaries: {} })
      return false
    })
    if (!ready) {
      const key = normalized.nodeId + '/' + rev
      let task = this.pending.get(key)
      if (!task) {
        task = this.generate(normalized, rev)
        this.pending.set(key, task)
        void task.then(() => { if (this.pending.get(key) === task) this.pending.delete(key) },
          () => { if (this.pending.get(key) === task) this.pending.delete(key) })
      }
      await task
    }
    return (await this.get(normalized.nodeId))!
  }
  private async generate(normalized: StudyTurnSource, rev: string) {
    let cache: Record<StudySummaryLevel, StudySummaryCache>
    try {
      const generated = await this.summarize(structuredClone(normalized))
      const title = text(generated.L0, 'L0 标题').replace(/\s+/gu, ' ').trim()
      const clippedTitle = safeSlice(title, 32).trimEnd()
      const generatedAt = new Date().toISOString()
      const common = {
        generatedAt,
        ...(generated.model !== undefined ? { model: text(generated.model, '摘要模型', false, 8192) } : {}),
        ...(generated.inputTruncated !== undefined ? { inputTruncated: Boolean(generated.inputTruncated) } : {}),
        ...(generated.outputTruncated !== undefined || clippedTitle.length < title.length ?
          { outputTruncated: Boolean(generated.outputTruncated) || clippedTitle.length < title.length } : {}),
      }
      cache = {
        L0: { text: text(clippedTitle, 'L0 标题'), ...common },
        L1: { text: text(generated.L1, 'L1 摘要'), ...common },
        L2: { text: text(generated.L2, 'L2 摘要'), ...common },
      }
    } catch (error) {
      await this.mutate(normalized.nodeId, metadata => {
        const version = metadata.versions.find(item => item.revision === rev)!
        version.state = 'failed'; version.error = message(error)
      })
      return
    }
    await this.mutate(normalized.nodeId, metadata => {
      const version = metadata.versions.find(item => item.revision === rev)!
      // Backfilling a title must not silently replace the summaries already cached for this revision.
      for (const level of levels) if (!hasSummary(version, level)) version.summaries[level] = cache[level]
      version.state = 'ready'; delete version.error
    })
  }
  async prepare(input: PrepareStudyContextRequest): Promise<PreparedStudyContext> {
    if (!input || typeof input !== 'object') throw new Error('上下文请求无效。')
    const nodeId = id(input.nodeId, '对话节点'), documentId = id(input.documentId, '对话或资料编号')
    const question = text(input.question, '问题', false, 4000)
    const choice = selection(input.selection)
    const materials = text(input.materials, '参考内容', true)
    const limit = input.limit ?? maxContext
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxContext) throw new Error('上下文长度上限无效。')
    if (!Array.isArray(input.ancestors) || input.ancestors.length > 1000) throw new Error('祖先节点列表无效。')
    const ancestors = input.ancestors.map(source)
    const seen = new Set([nodeId])
    for (let i = 0; i < ancestors.length; i++) {
      const item = ancestors[i]
      if (seen.has(item.nodeId) || item.document.id !== documentId) throw new Error('继承路径包含重复节点或其他对话、资料。')
      seen.add(item.nodeId)
      if (item.parentId && ancestors[i + 1] && item.parentId !== ancestors[i + 1].nodeId) throw new Error('继承节点没有沿父节点向上排列。')
    }
    const createdAt = new Date().toISOString()
    await this.mutate(nodeId, metadata => {
      const parentId = ancestors[0]?.nodeId
      if (metadata.parentId && metadata.parentId !== parentId) throw new Error('同一对话节点的父节点不能改变。')
      metadata.parentId ??= parentId
      metadata.requestInput = { question, documentId, selection: choice, ancestorNodeIds: ancestors.map(item => item.nodeId), createdAt }
      delete metadata.requestError
    })
    try {
      const chosen = ancestors.slice(0, choice.depth)
      const entries: PreparedStudyContext['entries'] = []
      const omittedNodeIds: string[] = []
      let context = '', truncated = false
      const append = (section: string) => {
        const full = (context ? '\n\n' : '') + section
        const used = safeSlice(full, limit - context.length)
        context += used
        if (used.length < full.length) truncated = true
        return { includedChars: used.length, truncated: used.length < full.length }
      }
      for (let index = 0; index < chosen.length; index++) {
        if (context.length >= limit) {
          omittedNodeIds.push(...chosen.slice(index).map(item => item.nodeId)); truncated = true; break
        }
        const item = chosen[index]
        let metadata = await this.get(item.nodeId)
        // save may fill a parent captured by an earlier request before hashing.
        let effective = metadata?.parentId && !item.parentId ? source({ ...item, parentId: metadata.parentId }) : item
        let rev = revision(effective)
        let version = metadata?.versions.find(item => item.revision === rev)
        // Existing L1/L2 remain usable while an older cache is missing or retrying L0.
        if (!hasSummary(version, choice.level)) {
          metadata = await this.save(item)
          effective = metadata.parentId && !item.parentId ? source({ ...item, parentId: metadata.parentId }) : item
          rev = revision(effective)
          version = metadata.versions.find(item => item.revision === rev)
        }
        const summary = version?.summaries[choice.level]
        if (!hasSummary(version, choice.level) || !summary) {
          throw new Error('节点 ' + item.nodeId + ' 的 ' + choice.level + ' 摘要尚未生成：' + (version?.error || '请重试。'))
        }
        const section = '【向上第 ' + (index + 1) + ' 层 · ' + choice.level + ' · 节点 ' + item.nodeId + ' · 版本 ' + rev + '】\n' + summary.text
        const included = append(section)
        entries.push({ nodeId: item.nodeId, revision: rev, level: choice.level, text: summary.text, ...included })
        if (included.truncated) {
          omittedNodeIds.push(...chosen.slice(index + 1).map(item => item.nodeId)); break
        }
      }
      const materialResult = materials && !truncated ? append('【本轮参考内容】\n' + materials) : { includedChars: 0 }
      const prepared: PreparedStudyContext = {
        nodeId, documentId, question, context, selection: choice, limit, used: context.length, truncated,
        entries, omittedNodeIds, materialsIncludedChars: materialResult.includedChars, createdAt,
      }
      await this.mutate(nodeId, metadata => { metadata.request = prepared; delete metadata.requestError })
      return structuredClone(prepared)
    } catch (error) {
      await this.mutate(nodeId, metadata => { metadata.requestError = message(error) })
      throw error
    }
  }
}
