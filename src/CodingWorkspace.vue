<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import ResizableSidebar from './ResizableSidebar.vue'
import ConversationCanvas from './ConversationCanvas.vue'
import QuestionCard from './QuestionCard.vue'
import SafeMarkdown from './SafeMarkdown.vue'
import CodingRunTrace from './CodingRunTrace.vue'
import { answerText, type Card, type CardQuestion } from './types'
import type { Block } from './library'
import type { CodeEngine, CodeFile, CodeProject, CodeStatus, CodeWorkspace } from './codingTypes'

type Kind = 'ask' | 'edit'
type Tab = 'conversation' | 'code' | 'changes' | 'trace'
interface CodeMeta { workspaceId: string; before: string; after: string; kind: Kind; file?: string; retryContext?: string }
interface ProjectNotes { activeWorkspace: string; blocks: Block[]; meta: Record<string, CodeMeta>; prompts: Record<string, string> }
interface Saved { activeProject: string; projects: Record<string, ProjectNotes> }
interface Draft { content: string; hash: string }
interface Editor { workspaceId: string; file: CodeFile; revision?: string; content: string; baseHash: string }
interface RunProgress { projectId: string; cardId: string; workspaceId: string; message: string; stopping: boolean; sent: boolean; startedAt: number }
const api = window.codingBridge
const storageKey = 'rove-coding-v1'
const draftsKey = 'rove-coding-drafts-v1'
const error = ref('')
function readStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback }
}
const saved = reactive(readStored<Saved>(storageKey, { activeProject: '', projects: {} }))
const drafts = reactive(readStored<Record<string, Draft>>(draftsKey, {}))
function writeStored(key: string, data: unknown) {
  try { localStorage.setItem(key, JSON.stringify(data)) }
  catch { error.value = '本地存储已满，当前会话仍可使用。请及时保存文件改动。' }
}
watch(saved, () => writeStored(storageKey, saved), { deep: true })
watch(drafts, () => writeStored(draftsKey, drafts), { deep: true })
function walkCards(roots: Card[], visit: (card: Card) => void) {
  const queue = [...roots]
  while (queue.length) { const card = queue.pop()!; visit(card); for (const child of card.children ?? []) queue.push(child) }
}
for (const book of Object.values(saved.projects)) {
  book.prompts ??= {}
  for (const block of book.blocks) walkCards(block.cards, card => {
    if (card.loading) { card.loading = false; card.answer ||= '上次运行已中断。可以从此节点重新提问。' }
  })
}
const projects = ref<CodeProject[]>([])
const engine = ref<CodeEngine>()
const engineChecking = ref(false)
const project = computed(() => projects.value.find(p => p.id === saved.activeProject))
const book = computed(() => project.value && saved.projects[project.value.id])
const workspace = computed(() => project.value?.workspaces.find(w => w.id === book.value?.activeWorkspace))
const status = ref<CodeStatus>()
const selectedId = ref('')
const selectedBlock = ref('')
const tab = ref<Tab>('conversation')
const panel = ref(true)
const filter = ref('')
const editor = ref<Editor>()
const selection = ref('')
const codeInput = ref<HTMLTextAreaElement>()
const promptInput = ref<HTMLTextAreaElement>()
const mutation = ref(false)
const reading = ref(false)
const switching = ref(false)
const fileSaving = ref(false)
const commitText = ref('')
const diffScope = ref<'working' | 'node'>('working')
const diffBody = ref('')
const diffLoading = ref(false)
const progress = reactive(new Map<string, RunProgress>())
const runClock = ref(Date.now())
const activeRun = computed(() => [...progress.entries()].find(([,run]) => run.projectId === project.value?.id))
const elapsedRun = computed(() => {
  const seconds = Math.max(0, Math.floor((runClock.value - (activeRun.value?.[1].startedAt ?? runClock.value)) / 1000))
  return '已运行 ' + (seconds >= 60 ? Math.floor(seconds / 60) + '分' : '') + seconds % 60 + '秒'
})
const parallelLock = computed(() => !!activeRun.value || mutation.value || switching.value || fileSaving.value)
let viewToken = 0, fileToken = 0, diffToken = 0
let unsubscribe: (() => void) | undefined
let runMonitor: ReturnType<typeof setInterval> | undefined
let statusPolling = false, lastStatusPoll = 0, disposed = false

async function refreshRunningStatus() {
  const run = activeRun.value
  if (!run || statusPolling || switching.value || disposed) return
  const [runId, job] = run
  const wid = workspace.value?.id, token = viewToken
  if (!job.sent || !wid || wid !== job.workspaceId || project.value?.id !== job.projectId) return
  statusPolling = true
  lastStatusPoll = Date.now()
  try {
    const next = await api.status(wid)
    // A completed run or a user navigation must never receive this older poll.
    if (!disposed && token === viewToken && progress.get(runId) === job &&
        workspace.value?.id === wid && project.value?.id === job.projectId) status.value = next
  } catch { /* A transient read while tools update files must not interrupt the task. */ }
  finally { statusPolling = false }
}

function fail(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason)
  error.value = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
function notes(p: CodeProject) {
  const n = saved.projects[p.id] ??= { activeWorkspace: '', blocks: [], meta: {}, prompts: {} }
  if (!n.blocks.length) n.blocks.push({ id: crypto.randomUUID(), title: p.name, body: p.root, cards: [] })
  return saved.projects[p.id]
}
function rememberWorkspace(p: CodeProject, w: CodeWorkspace) {
  if (!p.workspaces.some(existing => existing.id === w.id)) p.workspaces.push(w)
}
function updateProject(p: CodeProject) {
  const i = projects.value.findIndex(x => x.id === p.id)
  if (i === -1) projects.value.push(p)
  else projects.value[i] = p
}
async function showProject(p: CodeProject, workspaceId?: string) {
  const n = notes(p)
  const w = p.workspaces.find(x => x.id === (workspaceId || n.activeWorkspace)) ?? p.workspaces.find(x => x.isMain) ?? p.workspaces[0]
  const token = ++viewToken
  fileToken++; diffToken++
  saved.activeProject = p.id
  n.activeWorkspace = w?.id || ''
  selectedId.value = ''; selectedBlock.value = n.blocks[0].id
  filter.value = ''; status.value = undefined; editor.value = undefined; selection.value = ''
  error.value = ''; diffBody.value = ''; commitText.value = ''; reading.value = false; diffLoading.value = false
  tab.value = 'conversation'; panel.value = true
  switching.value = !!w
  if (!w) return
  try { const result = await api.status(w.id); if (token === viewToken) status.value = result }
  catch (e) { if (token === viewToken) fail(e) }
  finally { if (token === viewToken) switching.value = false }
}
async function openProject() {
  if (mutation.value || fileSaving.value) return
  mutation.value = true
  try { const p = await api.openProject(); if (p) { updateProject(p); await showProject(p) } }
  catch (e) { fail(e) } finally { mutation.value = false }
}
function changeProject(id: string) {
  const p = projects.value.find(item => item.id === id)
  if (p && !mutation.value && !fileSaving.value) void showProject(p)
}
function changeWorkspace(id: string) {
  if (project.value && !mutation.value && !fileSaving.value) void showProject(project.value, id)
}
async function useProjectDirectory() {
  const p = project.value
  const root = p?.workspaces.find(w => w.path === p.root)
  if (!p || !root || mutation.value || fileSaving.value) return
  const id = selectedId.value
  await showProject(p, root.id)
  if (id) selectNode(id)
}
async function checkEngine() {
  engineChecking.value = true
  try { engine.value = await api.engine() } catch(e) { fail(e) }
  finally { engineChecking.value = false }
}
onMounted(async () => {
  runMonitor = setInterval(() => {
    runClock.value = Date.now()
    if (runClock.value - lastStatusPoll >= 2000) void refreshRunningStatus()
  }, 1000)
  unsubscribe = api.onProgress(e => {
    const job = progress.get(e.runId)
    if (!job) return
    job.message = e.message
    const m = saved.projects[job.projectId]?.meta[job.cardId]
    if (m && e.before) m.before = e.before
  })
  void checkEngine()
  try {
    projects.value = await api.listProjects()
    const p = projects.value.find(x => x.id === saved.activeProject) ?? projects.value[0]
    if (p) await showProject(p)
  } catch (e) { fail(e) }
})
onBeforeUnmount(() => {
  disposed = true
  if (runMonitor) clearInterval(runMonitor)
  unsubscribe?.(); writeStored(draftsKey, drafts); writeStored(storageKey, saved)
})

const nodeIndex = computed(() => {
  const index = new Map<string, { card: Card; block: Block; parent?: Card }>()
  for (const block of book.value?.blocks ?? []) {
    const stack = block.cards.map(card => ({ card, parent: undefined as Card | undefined }))
    while (stack.length) {
      const { card, parent } = stack.pop()!
      index.set(card.id, { card, parent, block })
      for (const child of card.children ?? []) stack.push({ card: child, parent: card })
    }
  }
  return index
})
const selected = computed(() => nodeIndex.value.get(selectedId.value))
const meta = computed(() => book.value?.meta[selectedId.value])
const commits = computed(() => Object.fromEntries(Object.entries(book.value?.meta ?? {})
  .filter(([, node]) => node.after).map(([id, node]) => [id, node.after])))
const selectedPath = computed(() => editor.value?.file.path || '')
const files = computed(() => (status.value?.files ?? []).filter(file => file.toLowerCase().includes(filter.value.toLowerCase())))
const promptKey = computed(() => [workspace.value?.id, selectedId.value || selectedBlock.value].join('/'))
const prompt = computed({
  get: () => book.value?.prompts[promptKey.value] ?? '',
  set: value => { if (book.value) book.value.prompts[promptKey.value] = value },
})
function selectNode(id: string) {
  const item = nodeIndex.value.get(id)
  if (!item) return
  selectedId.value = id; selectedBlock.value = item.block.id; tab.value = 'conversation'; panel.value = true
}
function viewRunTrace() {
  const job = activeRun.value?.[1]
  if (!job) return
  selectNode(job.cardId)
  tab.value = 'trace'
}
function selectRoot(id?: string) {
  selectedId.value = ''; selectedBlock.value = id || book.value?.blocks[0]?.id || ''
  tab.value = 'conversation'; panel.value = true
}
async function focusPrompt() {
  tab.value = 'conversation'; panel.value = true
  await nextTick(); promptInput.value?.focus()
}
function selectParent() {
  const item = selected.value
  if (item?.parent) selectNode(item.parent.id)
  else selectRoot(item?.block.id)
}
function retrySelected() {
  const node = selected.value, m = meta.value
  if (node && m && !m.after) void runTask(m.kind,undefined,node.card)
}
function showHistoricalFile() {
  const m = meta.value
  if (m?.file && m.after) void loadFile(m.file,m.workspaceId,m.after)
}
function draftId(wid: string, path: string) { return wid + '/' + path }
const unsaved = computed(() => !!editor.value && !editor.value.revision &&
  (editor.value.content !== editor.value.file.content || editor.value.baseHash !== editor.value.file.hash))
async function loadFile(path: string, wid = workspace.value?.id, revision?: string, show = true) {
  if (!wid || fileSaving.value) return
  const token = ++fileToken, view = viewToken
  reading.value = true; selection.value = ''; editor.value = undefined
  if (show) { tab.value = 'code'; panel.value = true }
  try {
    const file = await api.readFile({ workspaceId: wid, path, revision })
    if (token !== fileToken || view !== viewToken) return
    const draft = revision ? undefined : drafts[draftId(wid, path)]
    editor.value = { workspaceId: wid, file, revision, content: draft?.content ?? file.content, baseHash: draft?.hash ?? file.hash }
    if (draft && draft.hash !== file.hash) error.value = '磁盘版本已变化。草稿仍保留，保存时会检查冲突。'
  } catch(e) { if (token === fileToken && view === viewToken) fail(e) }
  finally { if (token === fileToken) reading.value = false }
}
function editFile(value: string) {
  const e = editor.value
  if (!e || e.revision || fileSaving.value) return
  e.content = value
  const key = draftId(e.workspaceId, e.file.path)
  if (value === e.file.content) { e.baseHash = e.file.hash; delete drafts[key] }
  else drafts[key] = { hash: e.baseHash, content: value }
  selection.value = ''
}
function pickCode() {
  const el = codeInput.value
  if (el) selection.value = el.value.slice(el.selectionStart, el.selectionEnd)
}
async function saveFile() {
  const e = editor.value
  if (!e || e.revision || !unsaved.value || parallelLock.value) return
  fileSaving.value = true
  try {
    const file = await api.saveFile({ workspaceId: e.workspaceId, path: e.file.path, content: e.content, expectedHash: e.baseHash })
    e.file = file; e.baseHash = file.hash
    delete drafts[draftId(e.workspaceId,file.path)]
    if (workspace.value?.id === e.workspaceId) status.value = await api.status(e.workspaceId)
  } catch(reason) { fail(reason) } finally { fileSaving.value = false }
}
function discardDraft() {
  const e = editor.value
  if (!e || fileSaving.value || !window.confirm('放弃此文件的本地草稿，重新读取磁盘版本？')) return
  delete drafts[draftId(e.workspaceId,e.file.path)]
  void loadFile(e.file.path, e.workspaceId)
}
function short(hash?: string) { return hash?.slice(0,8) || '—' }

async function getDiff(scope: 'working' | 'node') {
  const w = workspace.value, m = meta.value
  if (!w || (scope === 'node' && (!m?.before || !m.after))) return
  const reference = ++diffToken, view = viewToken
  tab.value = 'changes'; panel.value = true; diffScope.value = scope
  diffBody.value = ''; diffLoading.value = true
  try {
    const wid = scope === 'node' ? m!.workspaceId : w.id
    const result = await api.diff({ workspaceId: wid, from: scope === 'node' ? m!.before : undefined, to: scope === 'node' ? m!.after : undefined })
    if (reference !== diffToken || view !== viewToken) return
    diffBody.value = result
    if (scope === 'working') {
      const next = await api.status(w.id)
      if (reference === diffToken && view === viewToken) status.value = next
    }
  } catch (e) { if (reference === diffToken && view === viewToken) fail(e) }
  finally { if(reference === diffToken) diffLoading.value = false }
}
async function checkpoint() {
  const w = workspace.value, message = commitText.value.trim(), view = viewToken
  if (!w || !message || parallelLock.value || unsaved.value) return
  mutation.value = true
  try {
    const result = await api.checkpoint({workspaceId:w.id,message})
    if (view === viewToken) { status.value=result;commitText.value='';await getDiff('working') }
  } catch(e) { if (view === viewToken) fail(e) } finally {mutation.value=false}
}
async function forkVersion() {
  const m = meta.value, p = project.value, name=selected.value?.card.question, view = viewToken
  if (!p || !m?.after || parallelLock.value) return
  mutation.value = true
  try {
    const w = await api.fork({workspaceId:m.workspaceId,commit:m.after,label:name?.slice(0,80)})
    if (!w) return
    rememberWorkspace(p,w)
    if (view === viewToken) {
      const id=selectedId.value
      await showProject(p,w.id)
      selectNode(id)
    }
  } catch(e) { if(view === viewToken) fail(e) } finally {mutation.value=false}
}

async function runTask(kind: Kind, followup?: CardQuestion, retry?: Card) {
  const p = project.value, n = book.value, w = workspace.value
  const promptText = (retry?.question ?? followup?.question ?? prompt.value).trim()
  const originalDraft = prompt.value, draftKey = promptKey.value
  if (!p || !n || !w || !promptText || parallelLock.value || reading.value) return
  if (!engine.value?.available || !engine.value.authenticated) {
    error.value = engine.value?.message || '请安装 dsh 并配置 DeepSeek API Key，然后重新检测。'
    return
  }
  const parent = retry ? nodeIndex.value.get(retry.id)?.parent : followup?.parent ?? selected.value?.card
  const target = (retry && nodeIndex.value.get(retry.id)?.block) || (parent && nodeIndex.value.get(parent.id)?.block) || n.blocks.find(b=>b.id===selectedBlock.value) || n.blocks[0]
  if (!target) return
  const previous = parent && n.meta[parent.id]
  if (parent?.loading || (previous && !previous.after)) { error.value='请等待此任务完成，或从已完成的节点继续。';return }
  const entry = editor.value?.workspaceId === w.id ? { ...editor.value } : undefined
  const picked = entry ? selection.value : ''
  const hasEditorDraft = unsaved.value
  const ancestry: string[] = []
  let cursor = parent
  while (cursor) {
    const a = cursor.id === followup?.parent.id ? followup.parentAnswer : answerText(cursor)
    ancestry.unshift('问题：' + cursor.question + '\n回答：' + a)
    cursor = nodeIndex.value.get(cursor.id)?.parent
  }
  if (promptText.length > 100_000) { error.value='问题过长，请缩短后重试。';return }
  let context = retry ? n.meta[retry.id]?.retryContext : undefined
  if (context === undefined) {
    const parts = ['本轮使用选定工作区的当前文件；历史对话和历史代码仅供参考。']
    if (ancestry.length) parts.push('历史对话路径\n' + ancestry.join('\n\n'))
    if (followup?.excerpt) parts.push('所引回答\n' + followup.excerpt)
    if (entry) {
      const historical = entry.revision ? '历史参考代码 @' + short(entry.revision) : '当前工作区代码'
      parts.push(historical + (picked ? '（选中片段）' : '（文件全文）') + '：' + entry.file.path +
        (!entry.revision && hasEditorDraft ? '（含尚未写入磁盘的编辑器草稿）' : '') + '\n' + (picked || entry.content))
    }
    context=parts.join('\n\n')
  }
  if (context.length > 500_000) { error.value='此次输入超过长度限制，请选取需要的代码片段，或从项目起点开启新分支。';return }
  const token = viewToken, runId = crypto.randomUUID(), id=retry?.id ?? crypto.randomUUID()
  const card: Card = retry ?? reactive({id,question:promptText,answer:'',excerpt:followup?.excerpt || '',excerptVersion:followup?.excerptVersion,children:[],demo:false})
  card.loading=true
  const m: CodeMeta = retry ? n.meta[id] : reactive({workspaceId:w.id,kind,before:'',after:'',file:entry?.file.path})
  m.retryContext=context
  n.meta[id] = m
  if (!followup && !retry && n.prompts[draftKey] === originalDraft) delete n.prompts[draftKey]
  if (!retry) {
    const children=parent ? (parent.children ??= []) : target.cards
    children.push(card)
  }
  runClock.value = Date.now()
  progress.set(runId,{projectId:p.id,workspaceId:w.id,cardId:id,message:'正在准备工作区…',stopping:false,sent:false,startedAt:runClock.value})
  selectNode(id)
  const job = progress.get(runId)!
  const runWorkspace = w
  try {
    // The selected workspace is the execution target. Conversation ancestry does not switch directories.
    m.workspaceId = runWorkspace.id
    job.workspaceId = runWorkspace.id
    const initialStatus = await api.status(runWorkspace.id)
    m.before = initialStatus.head
    if (token === viewToken && project.value?.id === p.id && workspace.value?.id === runWorkspace.id) {
      status.value = initialStatus
    }
    job.message = job.stopping ? '正在保存已停止任务的版本…' : kind === 'edit' ? 'DeepSeek Harness 正在当前工作区实现…' : 'DeepSeek Harness 正在阅读当前工作区…'
    const running = api.run({runId,nodeId:id,parentCommit:previous?.after,workspaceId:runWorkspace.id,kind,prompt:promptText,context})
    job.sent=true
    if (job.stopping) void api.cancel(runId).catch(fail)
    const result = await running
    if (!result.after || result.after===result.before || Object.entries(n.meta).some(([other,data])=>other!==id && data.after===result.after)) {
      throw new Error('Git 未返回此轮的独立版本。请重试绑定。')
    }
    m.workspaceId=result.status.workspace.id; m.before=result.before; m.after=result.after
    delete m.retryContext
    rememberWorkspace(p,result.status.workspace)
    card.answer = result.answer || (result.cancelled ? '任务已停止。' : '本次运行没有返回回答。')
    if (result.cancelled && result.answer) card.answer += '\n\n（任务已停止）'
    // Results update the visible files only when they belong to the still-selected workspace.
    if (token === viewToken && workspace.value?.id === result.status.workspace.id) status.value=result.status
  } catch (e) {
    card.answer='运行失败：' + (e instanceof Error ? e.message : String(e))
    if (project.value?.id === p.id && token === viewToken && workspace.value?.id === runWorkspace.id) {
      try { const latest=await api.status(runWorkspace.id); if (viewToken===token && workspace.value?.id===runWorkspace.id) status.value=latest } catch { /* Preserve the original error. */ }
    }
  } finally { card.loading=false;progress.delete(runId) }
}
async function stopTask() {
  if (!activeRun.value) return
  const [id,job]=activeRun.value
  job.stopping=true;job.message='正在停止…'
  if (job.sent) {
    try { await api.cancel(id) } catch(e) { job.stopping=false;fail(e) }
  }
}
function removeNode(card: Card) {
  const n = book.value, item = nodeIndex.value.get(card.id)
  if (!n || !item || activeRun.value || !window.confirm('删除这条对话及其追问？Git 版本会保留。')) return
  const siblings = item.parent?.children ?? item.block.cards
  const i=siblings.findIndex(c=>c.id===card.id)
  if(i<0)return
  walkCards([card], node=>{ delete n.meta[node.id] })
  siblings.splice(i,1)
  if(item.parent) selectNode(item.parent.id); else selectRoot(item.block.id)
}
</script>

<template>
  <div class="app-shell coding-shell">
    <ResizableSidebar side="left" storage-key="rove-code-left" :initial-width="230" :min-width="165" :max-width="345" :reserved-width="600" label="调整项目栏宽度">
      <aside class="sidebar code-library">
        <div class="brand"><span class="brand-icon" aria-hidden="true">R</span><b>Rove</b></div>
        <slot name="mode-switch" />
        <button type="button" class="new-doc" data-testid="coding-open" :disabled="mutation || fileSaving" @click="openProject"><span>＋</span> 打开项目</button>
        <template v-if="project">
          <div class="project-pickers">
            <label>项目<select aria-label="项目" data-testid="coding-project" :value="project.id" :disabled="mutation || fileSaving" @change="changeProject(($event.target as HTMLSelectElement).value)">
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
            <label>工作区<select aria-label="工作区" data-testid="coding-workspace" :value="workspace?.id" :disabled="mutation || fileSaving" @change="changeWorkspace(($event.target as HTMLSelectElement).value)">
              <option v-for="w in project.workspaces" :key="w.id" :value="w.id">{{ w.name }}{{ w.isMain ? ' · 主工作区' : '' }}</option></select></label>
          </div>
          <div v-if="workspace" class="workspace-location">
            <small>代码目录</small><p aria-label="代码写入目录">{{ workspace.path }}</p>
            <button v-if="workspace.path !== project.root" type="button" :disabled="mutation || fileSaving" @click="useProjectDirectory">使用项目目录</button>
          </div>
          <label class="file-filter"><span>文件</span><input type="search" v-model="filter" aria-label="筛选项目文件" placeholder="筛选文件…" /></label>
          <nav class="code-files" aria-label="项目文件">
            <button type="button" v-for="path in files" :key="path" data-testid="coding-file" :data-path="path" :aria-current="selectedPath === path ? 'location' : undefined" :disabled="fileSaving" :title="path" @click="loadFile(path)">
              <span class="file-glyph" aria-hidden="true">≡</span><span>{{ path }}</span><i v-if="workspace && drafts[draftId(workspace.id,path)]" title="有未保存草稿">●</i>
            </button>
            <p v-if="switching">正在读取项目…</p><p v-else-if="!files.length">{{ filter ? '没有匹配文件' : '工作区中没有可列出的文件' }}</p>
          </nav>
        </template>
        <div class="engine-status"><span class="engine-dot" :class="{online:engine?.authenticated && engine?.available}"></span>
          <div><b>DeepSeek Harness</b><small>{{ engineChecking ? '正在检测…' : engine?.authenticated && engine?.available ? '已配置' : engine?.message || '请安装 dsh 并配置 DeepSeek API Key。' }}</small></div>
          <button type="button" title="重新检测 DeepSeek Harness" aria-label="重新检测 DeepSeek Harness" :disabled="engineChecking" @click="checkEngine">↻</button>
        </div>
      </aside>
    </ResizableSidebar>
    <main class="code-main">
      <header class="code-top"><div><small>Coding</small><span aria-hidden="true">/</span><strong>{{ project?.name || '项目' }}</strong></div>
        <div v-if="workspace"><span class="branch-label" :title="workspace.path">{{ status?.branch || workspace.branch || workspace.name }}</span>
          <button type="button" :aria-pressed="panel" @click="panel=!panel">{{ panel ? '收起侧栏' : '打开侧栏' }}</button></div>
      </header>
      <div class="code-error" role="alert" v-if="error">{{ error }}<button aria-label="关闭提示" @click="error=''">×</button></div>
      <div v-if="!project" class="code-empty"><div><h1>打开项目文件夹</h1><p>Rove 会为普通文件夹自动初始化 Git。</p>
        <button type="button" class="code-primary" :disabled="mutation" @click="openProject">选择项目文件夹</button></div></div>
      <div v-else class="code-body">
        <ConversationCanvas title="探索地图" root-label="工作区" :document-name="project.name" :blocks="book?.blocks || []" :commits="commits" :selected-id="selectedId" :selected-block-id="selectedBlock"
          @select="selectNode" @read="selectRoot" @start="focusPrompt" />
        <ResizableSidebar v-show="panel" side="right" storage-key="rove-code-detail" :initial-width="425" :min-width="250" :reserved-width="290" label="调整 Coding 侧栏宽度">
          <aside class="code-inspector">
            <nav class="code-tabs" aria-label="工作区详情">
              <button type="button" aria-label="对话" :aria-pressed="tab==='conversation'" @click="tab='conversation'">对话</button>
              <button type="button" aria-label="代码" :aria-pressed="tab==='code'" @click="tab='code'">代码</button>
              <button type="button" aria-label="改动" :aria-pressed="tab==='changes'" @click="getDiff('working')">改动</button>
              <button type="button" aria-label="运行记录" :aria-pressed="tab==='trace'" :disabled="!selected || !meta" @click="tab='trace'">运行记录</button>
            </nav>
            <section v-if="tab==='conversation'" class="conversation-pane">
              <div class="code-detail-scroll">
                <template v-if="selected">
                  <button type="button" class="back-root" @click="selectParent">← {{ selected.parent ? '上层问题' : '项目起点' }}</button>
                  <QuestionCard :key="selected.card.id" standalone :card="selected.card" :selected-id="selected.card.id" @remove="removeNode" @ask="runTask('ask',$event)" />
                  <div v-if="meta" class="snapshot">
                    <span>{{ meta.kind==='edit' ? '实现记录' : '代码问答' }}</span>
                    <span>运行前</span><code :title="meta.before">{{ short(meta.before) }}</code><span aria-hidden="true">→</span><span>运行后</span><code v-if="meta.after" :title="meta.after">{{ short(meta.after) }}</code>
                    <span v-else>{{ selected.card.loading ? '运行中，结束后保存' : '尚未绑定 Git 节点' }}</span>
                    <div><button type="button" :disabled="!meta.before || !meta.after" @click="getDiff('node')">版本差异</button>
                      <button v-if="!meta.after && !selected.card.loading" type="button" :disabled="parallelLock" @click="retrySelected">重试本轮</button>
                      <button type="button" data-testid="coding-fork" :disabled="!meta.after || parallelLock" @click="forkVersion">在其他目录分叉</button>
                      <button v-if="meta.file && meta.after" type="button" :disabled="fileSaving" @click="showHistoricalFile">当时的代码</button></div>
                  </div>
                </template>
                <template v-else>
                  <h2>{{ project?.name }}</h2>
                  <p class="workspace-path">{{ workspace?.path || project?.root }}</p>
                  <p class="pane-note">选择项目文件后，可以选中一段代码提问。</p>
                </template>
              </div>
              <form class="task-form" @submit.prevent="runTask('ask')">
                <label for="code-prompt">{{ selected ? '沿此节点继续' : '探索项目' }}</label>
                <small v-if="editor && editor.workspaceId === workspace?.id">{{ editor.revision ? '历史参考代码' : selection ? '已选代码' : '当前文件' }} · {{ selectedPath }}{{ unsaved ? ' · 含草稿' : '' }}</small>
                <textarea id="code-prompt" ref="promptInput" v-model="prompt" rows="3" data-testid="coding-prompt" placeholder="你想了解或实现什么？" @keydown.meta.enter.prevent="runTask('ask')" />
                <div class="task-buttons"><button type="submit" data-testid="coding-ask" :disabled="!prompt.trim() || parallelLock || reading">问代码</button>
                  <button type="button" class="code-primary" data-testid="coding-edit" :disabled="!prompt.trim() || parallelLock || reading" @click="runTask('edit')">让 AI 实现</button></div>
              </form>
            </section>
            <section v-else-if="tab==='code'" class="editor-pane">
              <template v-if="editor">
                <div class="file-title"><b>{{ editor.file.path }}</b><small v-if="editor.revision">只读快照 · {{ short(editor.revision) }}</small><small v-else>{{ unsaved ? '未保存草稿' : '已保存' }}</small></div>
                <textarea :value="editor.content" ref="codeInput" data-testid="coding-editor" aria-label="代码编辑器" class="code-editor" :readonly="!!editor.revision || fileSaving" spellcheck="false" autocapitalize="off" @input="editFile(($event.target as HTMLTextAreaElement).value)" @select="pickCode" @keydown.meta.s.prevent="saveFile" />
                <div class="code-footer"><button type="button" @click="focusPrompt">{{ selection ? '问所选代码' : '问此文件' }}</button>
                  <button v-if="unsaved" type="button" :disabled="fileSaving" @click="discardDraft">放弃草稿</button>
                  <button type="button" data-testid="coding-save" class="code-primary" :disabled="!unsaved || parallelLock" @click="saveFile">保存文件</button></div>
              </template><p v-else class="pane-note">{{ reading ? '正在读取文件…' : '从左侧选择文件。' }}</p>
            </section>
            <section v-else-if="tab==='trace'" class="trace-pane">
              <CodingRunTrace v-if="selected && meta" :workspace-id="meta.workspaceId" :node-id="selected.card.id" :running="selected.card.loading" />
              <p v-else class="pane-note">从地图选择一轮对话，查看其运行记录。</p>
            </section>
            <section v-else class="diff-pane">
              <div class="diff-tools"><button type="button" :aria-pressed="diffScope==='working'" @click="getDiff('working')">工作区改动</button>
                <button v-if="meta?.after" type="button" :aria-pressed="diffScope==='node'" @click="getDiff('node')">节点版本</button></div>
              <ul v-if="diffScope==='working' && status?.changes.length" class="changed-files"><li v-for="change in status.changes" :key="change.path"><code>{{ change.status }}</code><button type="button" @click="loadFile(change.path)">{{ change.path }}</button></li></ul>
              <pre v-if="diffBody" class="diff-view" aria-label="Git 差异">{{ diffBody }}</pre><p v-else class="pane-note">{{ diffLoading ? '正在比较…' : '没有差异' }}</p>
              <form v-if="diffScope==='working'" class="commit-form" @submit.prevent="checkpoint">
                <label for="commit-message">提交工作区改动</label><input id="commit-message" v-model="commitText" data-testid="coding-commit-message" placeholder="提交说明" />
                <small v-if="unsaved">请先保存当前文件或放弃草稿。</small>
                <button type="submit" data-testid="coding-commit" :disabled="!status?.dirty || !commitText.trim() || parallelLock || unsaved">保存 Git 提交</button></form>
            </section>
          </aside>
        </ResizableSidebar>
      </div>
      <div v-if="activeRun" class="progress-strip" role="status"><i></i><span>{{ activeRun[1].message }}</span><small>{{ elapsedRun }}</small>
        <button type="button" data-testid="coding-view-trace" @click="viewRunTrace">查看记录</button>
        <button type="button" data-testid="coding-stop" :disabled="activeRun[1].stopping" @click="stopTask">{{ activeRun[1].stopping ? '正在停止' : '停止' }}</button></div>
    </main>
  </div>
</template>

<style scoped>
.coding-shell { display:flex; height:100vh; min-height:0; color:#253c31; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; background:#f7f8f4; }
.code-library { width:100%; height:100%; min-width:0; overflow:hidden; }
.code-library .new-doc { flex:none; margin:14px 0; }
.project-pickers { display:grid; gap:8px; margin:0 0 13px; }
.project-pickers label,.file-filter,.task-form label,.commit-form label { display:block; font-size:11px; font-weight:600; color:#596c5d; }
.project-pickers select,.file-filter input,.commit-form input { display:block; box-sizing:border-box; width:100%; min-width:0; margin-top:4px; padding:5px 6px; border:1px solid #d4ddd2; border-radius:6px; background:#fcfdfb; font-family:inherit; font-size:12px; line-height:1.4; color:#314f3b; }
.workspace-location { margin:0 0 12px; }
.workspace-location small { color:#596c5d; font-size:11px; font-weight:600; }
.workspace-location p { margin:4px 0 6px; color:#637568; font:10px/1.5 ui-monospace,monospace; overflow-wrap:anywhere; user-select:text; }
.workspace-location button { padding:3px 6px; border:1px solid #d1dbd0; border-radius:5px; background:#fcfdfb; color:#385441; font:11px/1.35 -apple-system,BlinkMacSystemFont,sans-serif; cursor:pointer; }
.file-filter { margin:3px 0 6px; }
.code-files { flex:1; min-height:0; overflow:auto; }
.code-files button { width:100%; display:flex; align-items:center; gap:6px; padding:5px 4px; border:0; background:none; border-radius:5px; color:#45594a; text-align:left; font:12px/1.45 ui-monospace,monospace; cursor:pointer; }
.code-files button span:nth-child(2) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.code-files button:hover,.code-files [aria-current] { background:#e2eadf; }
.file-glyph,.code-files i { color:#718b74; font-size:11px; }
.code-files p,.pane-note { color:#718075; font-size:12px; line-height:1.6; }
.engine-status { flex:none; display:flex; align-items:center; gap:7px; padding-top:12px; margin-top:auto; border-top:1px solid #dbe2d8; }
.engine-status div { min-width:0;flex:1; }
.engine-status b,.engine-status small { display:block; font-size:11px; font-weight:500; }
.engine-status small { color:#67796b; padding-top:2px; }
.engine-dot,.progress-strip i { width:7px; height:7px; border-radius:50%; background:#9caaa0; }
.engine-dot.online,.progress-strip i { background:#658b69; }
.code-main { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; overflow:hidden; background:#fff; }
.code-top { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:49px; padding:0 15px; border-bottom:1px solid #dfe5dd; }
.code-top>div,.task-buttons,.code-footer,.diff-tools,.snapshot>div { display:flex; align-items:center; gap:7px; min-width:0; }
.code-top small,.code-top span { color:#647367; font-size:12px; }
.code-top strong { font-size:13px; overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.branch-label,.snapshot code { font-family:ui-monospace,monospace; }
.branch-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:170px; }
.code-main button:not(.canvas-node):not(.question-card button):not(.conversation-canvas button),.engine-status button { cursor:pointer; }
.code-top button,.engine-status button,.code-footer button,.task-buttons button,.snapshot button,.diff-tools button,.commit-form button,.progress-strip button,.code-empty button { padding:5px 9px; border:1px solid #d1dbd0; border-radius:6px; background:#fff; color:#385441; font:500 12px/1.35 -apple-system,BlinkMacSystemFont,sans-serif; }
.coding-shell button:disabled { opacity:.5; cursor:default; }
.code-main .code-primary { color:white; background:#446b50; border-color:#446b50; }
.code-body { display:flex; flex:1; min-height:0; min-width:0; }
.code-inspector { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; border-left:1px solid #dce2da; background:#fbfcfa; }
.code-tabs { display:flex; flex-wrap:wrap; flex:none; gap:3px; padding:8px 10px; border-bottom:1px solid #dce3d9; }
.code-tabs button,.back-root { border:0; border-radius:5px; background:transparent; padding:5px 9px; color:#607164; font:500 12px/1.35 -apple-system,BlinkMacSystemFont,sans-serif; }
.code-tabs button[aria-pressed=true],.diff-tools button[aria-pressed=true] { background:#e5ede3; color:#35553d; }
.conversation-pane,.editor-pane,.diff-pane,.trace-pane { flex:1; min-height:0; display:flex; flex-direction:column; }
.code-detail-scroll,.diff-pane { overflow:auto; }
.code-detail-scroll { flex:1; min-height:0; padding:15px; }
.code-detail-scroll h2,.code-empty h1 { margin:4px 0; font-size:19px; font-weight:600; }
.workspace-path,.file-title b { overflow-wrap:anywhere; font:12px/1.5 ui-monospace,monospace; }
.back-root { padding-left:0; }
.snapshot { display:flex; align-items:center; flex-wrap:wrap; gap:5px 7px; margin:14px 0; color:#5b6d60; font-size:11px; }
.snapshot>div { width:100%; flex-wrap:wrap; }
.snapshot code { padding:2px 4px;background:#eaf0e8;border-radius:3px; }
.task-form,.commit-form { display:grid; gap:8px; padding:12px; border-top:1px solid #dce4da; background:white; }
.task-form small,.file-title small,.commit-form small { color:#66776a; font-size:11px; overflow-wrap:anywhere; }
.task-form textarea { resize:vertical; min-height:48px; max-height:150px; padding:8px; border:1px solid #cfdacf; border-radius:7px; font-family:inherit; font-size:13px; line-height:1.5; color:#304937; }
.task-buttons { justify-content:flex-end; }
.file-title { display:flex; align-items:center; justify-content:space-between; gap:9px; padding:11px 12px; }
.code-editor,.diff-view { font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; border:0; background:#fff; padding:10px 12px; color:#2b4131; }
.code-editor { min-width:0; flex:1; resize:none; tab-size:4; white-space:pre; overflow:auto; border-top:1px solid #e5eae2; }
.code-footer,.diff-tools { padding:9px; flex-wrap:wrap; border-top:1px solid #dce2d9; }
.editor-pane>.pane-note,.diff-pane>.pane-note { padding:0 12px; }
.diff-view { margin:0; min-height:100px; flex:1; overflow:auto; }
.changed-files { list-style:none; padding:0 12px; margin:6px 0; max-height:105px; overflow:auto; font-size:11px; }
.changed-files li { display:flex; align-items:baseline; gap:6px; }
.changed-files button { border:0; padding:3px; background:none; color:#456c4f; overflow-wrap:anywhere; text-align:left; }
.commit-form { margin-top:auto; }
.progress-strip,.code-error { display:flex; align-items:center; gap:8px; padding:7px 15px; font-size:12px; background:#edf3eb; }
.progress-strip small { flex:none; color:#637568; font-size:11px; font-variant-numeric:tabular-nums; }
.progress-strip span,.code-error span { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.code-error { color:#86462e; background:#fff0e7; word-break:break-word; }
.code-error button { margin-left:auto; border:0; background:none; }
.code-empty { flex:1; display:grid; place-items:center; padding:30px; }
.code-empty p { font-size:13px; color:#637366; }
</style>
