<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import PdfViewer from './PdfViewer.vue'
import QuestionCard from './QuestionCard.vue'
import ConversationCanvas from './ConversationCanvas.vue'
import ResizableSidebar from './ResizableSidebar.vue'
import SafeMarkdown from './SafeMarkdown.vue'
import { selectedAnswerText } from './selectedText'
import { buildLecturePrompt, parseLecture } from './lectureFormat'
import { restoreLectureSections } from './lectureSections'
import { readStudyOutline, type StudyOutlineItem } from './studyOutline'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { readLibrary, saveLibrary, loadPdf, type Block } from './library'
import type { Card, CardQuestion } from './types'

type Pdf = { name: string; source: { url: string } | { data: string } }
type Page = { page: number; text: string }
const library = ref(readLibrary())
const note = computed(() => library.value.notes.find(item => item.id === library.value.active) || library.value.notes[0])
const blocks = computed(() => note.value.blocks)
const documentName = computed(() => note.value.name)
const pdf = ref<Pdf | null>(null)
const pdfViewer = ref<{ extractForLecture(): Promise<Page[]>; goToPage(page: number): void; getCurrentPageText(): Promise<Page> } | null>(null)
const sidebarTab = ref<'library' | 'outline'>('library')
const readerOpen = ref(true)
const readerTab = ref<'content' | 'source'>('content')
const selectedCardId = ref<string>()
const selectedBlockId = ref(blocks.value[0]?.id || '')
const selectedBlock = computed(() => blocks.value.find(block => block.id === selectedBlockId.value) || blocks.value[0])
const outline = ref<StudyOutlineItem[]>([])
const pageCount = ref(0)
const sourcePage = ref(1)
const quotePage = ref<number>()
const selection = ref('')
const draft = ref('')
const questionInput = ref<HTMLTextAreaElement>()
const chapterBody = ref<HTMLElement>()
const hasKnowledge = computed(() => blocks.value.some(block => block.title !== '准备开始学习'))
const generating = ref(false)
const importing = ref(false)
const error = ref('')
const settingsOpen = ref(false)
const aiConfig = ref({ baseUrl: '', model: '', configured: false })
const ready = computed(() => aiConfig.value.configured)
const configError = ref('')
let pendingConfig: Promise<typeof aiConfig.value> | undefined
let navigationVersion = 0
let switchToken = 0

function headingText(title: string) {
  if (title === '准备开始学习') return '整份资料'
  const match = title.match(/^\s*(?:\d+[.、]\s*)?(.+?)\s*[（(]第\s*(\d+)\s*题[）)]$/)
  return match ? '第 ' + match[2] + ' 题 · ' + match[1] : title.replace(/^\d+[.、]\s+/, '')
}
function noteLabel(label: string) { return label.replace(/讲义/g, '知识点') }
function problemNumber(title: string) { return title.match(/第\s*(\d+)\s*题/)?.[1] }
function pageForBlock(block: Block) {
  const number = problemNumber(block.title)
  return (number && outline.value.find(item => problemNumber(item.title) === number)?.page) || block.page
}

async function onDocumentReady(doc: PDFDocumentProxy) {
  const id = ++navigationVersion
  pageCount.value = doc.numPages
  const target = note.value
  if (target.blocks.some((block, i) => block.title === '讲义概览' && /^知识点\s+\d+$/.test(target.blocks[i + 1]?.title || ''))) {
    const previousId = selectedBlockId.value
    target.blocks = restoreLectureSections(target.blocks, doc.numPages)
    if (!target.blocks.some(block => block.id === previousId)) selectedBlockId.value = target.blocks[0]?.id || ''
  }
  try {
    const items = await readStudyOutline(doc)
    if (id === navigationVersion) outline.value = items
  } catch { /* The source remains readable without an outline. */ }
}
function clearSelection() {
  selection.value = ''
  quotePage.value = undefined
}
function readBlock(id: string) {
  if (!blocks.value.some(block => block.id === id)) return
  if (selectedBlockId.value !== id || selectedCardId.value) {
    clearSelection()
    draft.value = ''
  }
  selectedBlockId.value = id
  selectedCardId.value = undefined
  readerOpen.value = true
  readerTab.value = 'content'
}
async function showSource(page = sourcePage.value) {
  if (!pdf.value) return
  readerOpen.value = true
  readerTab.value = 'source'
  await nextTick()
  pdfViewer.value?.goToPage(page)
}
function captureChapterSelection() {
  const root = chapterBody.value
  const current = window.getSelection()
  if (!root || !current?.rangeCount || current.isCollapsed) return
  const range = current.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  const text = selectedAnswerText(root, range)
  if (!text) return
  selection.value = text
  quotePage.value = undefined
}
function selectOriginal({ page, text }: Page) {
  if (!text.trim()) return
  selection.value = text.slice(0, 4000)
  quotePage.value = page
  const matches = blocks.value.filter(block => pageForBlock(block) && Number(pageForBlock(block)) <= page)
  selectedBlockId.value = matches.at(-1)?.id || blocks.value[0]?.id || ''
}

function readAIConfig() {
  pendingConfig ??= window.studyBridge.getAIConfig().then(config => {
    aiConfig.value = config
    configError.value = ''
    return config
  }).catch(reason => {
    aiConfig.value = { baseUrl: '', model: '', configured: false }
    configError.value = reason instanceof Error ? reason.message : '读取 .env 失败。'
    throw reason
  }).finally(() => { pendingConfig = undefined })
  return pendingConfig
}
function refreshAIConfig() { void readAIConfig().catch(() => {}) }
async function showEnvFile() {
  try { await window.studyBridge.showEnvFile() }
  catch (reason) { configError.value = reason instanceof Error ? reason.message : '无法在 Finder 中显示 .env。' }
}
watch(settingsOpen, open => { if (open) refreshAIConfig() })
watch(library, () => {
  try { saveLibrary(library.value) }
  catch { error.value = '本地保存失败，存储空间可能已满。' }
}, { deep: true })

async function activate(id: string) {
  const current = library.value.notes.find(item => item.id === id)
  if (!current) return
  const token = ++switchToken
  ++navigationVersion
  library.value.active = id
  pdf.value = null
  clearSelection()
  draft.value = ''
  outline.value = []
  pageCount.value = 0
  sourcePage.value = 1
  selectedBlockId.value = current.blocks[0]?.id || ''
  selectedCardId.value = undefined
  readerOpen.value = true
  readerTab.value = 'content'
  sidebarTab.value = 'library'
  if (!current.pdfId) return
  const name = current.name + '.pdf'
  if (current.storage === 'file' && /^[a-f0-9]{64}$/.test(current.pdfId)) {
    pdf.value = { name, source: { url: 'zhixu-pdf://library/' + current.pdfId } }
  } else {
    try {
      const data = await loadPdf(current.pdfId)
      if (token !== switchToken) return
      if (data) pdf.value = { name, source: { data } }
      else error.value = '未找到原 PDF，请重新导入。'
    } catch {
      if (token === switchToken) error.value = '原 PDF 恢复失败，请重新导入。'
    }
  }
  if (token === switchToken && !hasKnowledge.value) readerTab.value = 'source'
}
onMounted(() => {
  void activate(library.value.active)
  refreshAIConfig()
  window.addEventListener('focus', refreshAIConfig)
})
onBeforeUnmount(() => window.removeEventListener('focus', refreshAIConfig))

async function openPdf() {
  if (importing.value) return
  importing.value = true
  error.value = ''
  try {
    const result = await window.studyBridge.openPdf()
    if (!result) return
    let target = library.value.notes.find(item => item.pdfId === result.pdfId)
    if (target) target.storage = 'file'
    else {
      target = {
        id: crypto.randomUUID(), name: result.name.replace(/\.pdf$/i, ''), label: 'PDF 已导入',
        pdfId: result.pdfId, storage: 'file',
        blocks: [{ id: crypto.randomUUID(), title: '准备开始学习', body: '', cards: [] }]
      }
      library.value.notes.push(target)
    }
    await activate(target.id)
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.replace(/^Error invoking remote method 'pdf:open': (?:Error: )?/, '') : String(reason)
    error.value = '导入失败：' + message
  } finally { importing.value = false }
}
async function askEngine(question: string, context: string): Promise<{ answer: string; demo: boolean }> {
  const config = await readAIConfig()
  if (!config.configured) return { answer: '请在 AI 设置中配置模型，再针对这段资料提问。', demo: true }
  return { answer: await window.studyBridge.ask({ question, context }), demo: false }
}
async function generateKnowledge() {
  const viewer = pdfViewer.value
  if (!pdf.value || !viewer || generating.value) return
  const target = note.value
  generating.value = true
  error.value = ''
  try {
    const config = await readAIConfig()
    if (target.id !== note.value.id || viewer !== pdfViewer.value) return
    if (!config.configured) { error.value = '请先在 AI 设置中配置模型。'; return }
    const pages = await viewer.extractForLecture()
    if (target.id !== note.value.id || viewer !== pdfViewer.value) return
    if (!pages.some(page => page.text.trim())) { error.value = '未检测到可提取文字，扫描版 PDF 暂不支持 OCR。'; return }
    const full = pages.map(page => `[第 ${page.page} 页]\n${page.text}`).join('\n\n')
    const count = pageCount.value
    const answer = await window.studyBridge.ask({ question: buildLecturePrompt(), context: full.slice(0, 24000) })
    const sections = parseLecture(answer, count)
    if (!sections.length) throw new Error('未收到可用的知识点内容。')
    const generated = sections.map(section => ({ ...section, id: crypto.randomUUID(), cards: [] as Card[] }))
    for (const block of target.blocks) {
      if (!block.cards.length) continue
      const match = generated.find(item => item.title === block.title)
      if (match) match.cards.push(...block.cards)
      else generated.push({ ...block })
    }
    target.blocks = generated
    target.label = full.length > 24000 ? 'AI 知识点 · 已截取前 24,000 字' : 'AI 知识点'
    if (target.id === note.value.id) {
      selectedBlockId.value = mapped.value?.block.id || generated[0].id
      if (!mapped.value) selectedCardId.value = undefined
      readerOpen.value = true
      readerTab.value = 'content'
    }
  } catch (reason) {
    if (target.id === note.value.id) error.value = '知识点整理失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally { generating.value = false }
}

function cardPath(cards: Card[], id: string): Card[] | undefined {
  for (const card of cards) {
    if (card.id === id) return [card]
    const child = cardPath(card.children, id)
    if (child) return [card, ...child]
  }
}
const mapped = computed(() => {
  const id = selectedCardId.value
  if (!id) return
  for (const block of blocks.value) {
    const path = cardPath(block.cards, id)
    if (path) return { block, path, card: path[path.length - 1] }
  }
})
function selectMappedCard(id: string) {
  selectedCardId.value = id
  if (!mapped.value) return
  selectedBlockId.value = mapped.value.block.id
  readerOpen.value = true
  readerTab.value = 'content'
  clearSelection()
}
function closeReader() {
  readerOpen.value = false
  nextTick(() => {
    const key = selectedCardId.value ? 'q/' + selectedCardId.value : 'b/' + selectedBlockId.value
    document.querySelector<HTMLElement>('[data-node="' + CSS.escape(key) + '"]')?.focus({ preventScroll: true })
  })
}
function startQuestion(blockId?: string) {
  const target = blocks.value.find(block => block.id === (blockId || selectedBlockId.value)) || blocks.value[0]
  if (!target) return
  readBlock(target.id)
  nextTick(() => questionInput.value?.focus())
}
async function addQuestion(target: Block, question: string, excerpt: string, followup?: CardQuestion) {
  const parent = followup?.parent
  const page = parent ? parent.page : quotePage.value ?? (readerTab.value === 'source' ? sourcePage.value : pageForBlock(target))
  const viewer = pdfViewer.value
  const docName = documentName.value
  const card: Card = reactive({
    id: crypto.randomUUID(), question, excerpt, excerptVersion: followup?.excerptVersion,
    page, answer: '', children: [], demo: !ready.value, loading: true
  })
  const siblings = parent ? parent.children : target.cards
  siblings.push(card)
  selectedCardId.value = card.id
  selectedBlockId.value = target.id
  readerOpen.value = true
  readerTab.value = 'content'
  try {
    const parts = [`资料：${docName}`, `知识点：${target.title}`]
    if (excerpt) parts.push('选中内容：' + excerpt)
    if (followup) parts.push('上层问题：' + followup.parent.question, '上层回答：' + followup.parentAnswer)
    parts.push(target.body)
    if (page) {
      parts.push('原文第 ' + page + ' 页')
      if (page === sourcePage.value && viewer) {
        const current = await viewer.getCurrentPageText()
        if (current.page === page) parts.push(current.text)
      }
    }
    const result = await askEngine(question, parts.join('\n'))
    card.answer = result.answer
    card.demo = result.demo
  } catch (reason) { card.answer = '回答失败：' + (reason instanceof Error ? reason.message : String(reason)) }
  finally { card.loading = false }
}
function branchFrom(block: Block, followup: CardQuestion) { void addQuestion(block, followup.question, followup.excerpt, followup) }
function submitQuestion() {
  const question = draft.value.trim()
  const block = selectedBlock.value
  if (!question || !block) return
  draft.value = ''
  void addQuestion(block, question, selection.value)
  clearSelection()
}
function removeCard(card: Card) {
  function remove(list: Card[]): boolean {
    const index = list.findIndex(item => item.id === card.id)
    if (index >= 0) { list.splice(index, 1); return true }
    return list.some(item => remove(item.children))
  }
  blocks.value.some(block => remove(block.cards))
  if (!mapped.value) selectedCardId.value = undefined
}
</script>

<template>
  <div class="app-shell">
    <ResizableSidebar side="left" storage-key="folio-library-width" :initial-width="224" :min-width="176" :max-width="340" :reserved-width="660" label="调整资料库宽度" class="library-sidebar">
      <aside class="sidebar">
        <div class="brand"><span class="brand-icon" aria-hidden="true">R</span><b>Rove</b></div>
        <slot name="mode-switch" />
        <button class="new-doc" :disabled="importing" @click="openPdf"><span>＋</span> {{ importing ? '正在导入…' : '导入学习资料' }} <kbd>PDF</kbd></button>
        <div class="rail-tabs">
          <button :aria-pressed="sidebarTab === 'library'" @click="sidebarTab='library'">资料库</button>
          <button :aria-pressed="sidebarTab === 'outline'" @click="sidebarTab='outline'">目录</button>
        </div>
        <div class="rail-scroll">
          <nav v-if="sidebarTab === 'outline'" aria-label="当前资料目录">
            <h2 v-if="hasKnowledge" class="rail-heading">知识点</h2>
            <button v-for="block in blocks" :key="block.id" class="toc-item" :class="{current:selectedBlockId === block.id}" @click="readBlock(block.id)">
              <span><SafeMarkdown :text="headingText(block.title)" inline /></span>
            </button>
            <h2 v-if="outline.length" class="rail-heading">原文目录</h2>
            <button v-for="item in outline" :key="item.page + item.title" class="toc-item original" @click="showSource(item.page)">
              <span>{{ item.title }}</span><small>{{ item.page }}</small>
            </button>
          </nav>
          <nav v-else aria-label="我的资料">
            <h2 class="rail-heading">我的资料 <small>{{ library.notes.length }}</small></h2>
            <button v-for="item in library.notes" :key="item.id" class="file-item library-item" :class="{active:item.id === note.id}" @click="activate(item.id)">
              <span aria-hidden="true">▤</span><div><strong>{{ item.name }}</strong><small>{{ noteLabel(item.label) }}</small></div>
            </button>
          </nav>
        </div>
        <div class="sidebar-bottom"><button class="settings-link" @click="settingsOpen=true">⚙ <span>AI 设置</span><i>{{ ready ? '已配置' : '演示模式' }}</i></button></div>
      </aside>
    </ResizableSidebar>
    <main class="main">
      <header class="topbar">
        <div class="breadcrumbs"><button @click="sidebarTab='library'">资料库</button><span class="slash">/</span><b>{{ documentName }}</b></div>
        <div class="reader-actions">
          <button v-if="pdf" type="button" @click="showSource()">PDF 原文</button>
          <button type="button" @click="readerOpen=true">阅读</button>
        </div>
      </header>
      <div v-if="error" class="error-bar" role="alert">{{ error }} <button aria-label="关闭提示" @click="error=''">×</button></div>
      <div class="workspace map-workspace" aria-label="对话地图">
        <ConversationCanvas :key="note.id" :document-name="documentName" :blocks="blocks" :selected-id="selectedCardId" :selected-block-id="readerOpen ? selectedBlockId : undefined"
          @select="selectMappedCard" @read="readBlock" @start="startQuestion">
          <template #actions>
            <button v-if="pdf && !hasKnowledge" class="generate" :disabled="generating" @click="generateKnowledge">{{ generating ? '正在整理…' : '整理知识点' }}</button>
          </template>
        </ConversationCanvas>
        <ResizableSidebar v-show="readerOpen" side="right" storage-key="folio-reader-width" :initial-width="460" :min-width="280" :reserved-width="300" label="调整阅读栏宽度" class="reader-sidebar">
          <aside class="map-detail" aria-label="阅读侧栏">
            <header class="map-detail-bar">
              <div class="reader-tabs" aria-label="阅读内容">
                <button type="button" :aria-pressed="readerTab === 'content'" @click="readerTab='content'">内容</button>
                <button v-if="pdf" type="button" :aria-pressed="readerTab === 'source'" @click="showSource()">PDF 原文</button>
              </div>
              <button type="button" class="close-inspector" aria-label="关闭阅读侧栏" @click="closeReader">×</button>
            </header>
            <div v-if="readerTab === 'content'" :key="selectedCardId || selectedBlockId" class="map-detail-scroll">
              <template v-if="mapped">
                <button type="button" class="reader-parent" @click="readBlock(mapped.block.id)">← <SafeMarkdown inline :text="headingText(mapped.block.title)" /></button>
                <QuestionCard :key="mapped.card.id" standalone :card="mapped.card" :page-count="pageCount" :selected-id="selectedCardId"
                  @source="showSource" @ask="branchFrom(mapped.block, $event)" @remove="removeCard" />
                <div v-if="mapped.card.children.length" class="reader-branches">
                  <span>后续追问</span>
                  <button v-for="child in mapped.card.children" :key="child.id" type="button" @click="selectMappedCard(child.id)"><SafeMarkdown inline :text="child.question" /><span aria-hidden="true">↗</span></button>
                </div>
              </template>
              <section v-else-if="selectedBlock" class="chapter-reader">
                <h1><SafeMarkdown inline :text="headingText(selectedBlock.title)" /></h1>
                <button v-if="pdf && pageForBlock(selectedBlock)" class="source-link" @click="showSource(Number(pageForBlock(selectedBlock)))">原文第 {{ pageForBlock(selectedBlock) }} 页 ↗</button>
                <p v-if="selectedBlock.title === '准备开始学习'" class="reader-hint">打开 PDF 原文开始阅读，或整理知识点后从地图进入。</p>
                <div v-else ref="chapterBody" class="chapter-copy" @pointerup="captureChapterSelection" @keyup="captureChapterSelection">
                  <SafeMarkdown :text="selectedBlock.body" :page-count="pageCount" @source="showSource" />
                </div>
                <div v-if="selectedBlock.cards.length" class="reader-branches">
                  <span>相关提问</span>
                  <button v-for="card in selectedBlock.cards" :key="card.id" type="button" @click="selectMappedCard(card.id)"><SafeMarkdown inline :text="card.question" /><span aria-hidden="true">↗</span></button>
                </div>
              </section>
            </div>
            <div v-if="pdf" v-show="readerTab === 'source'" class="reader-pdf">
              <PdfViewer ref="pdfViewer" :key="note.id" :source="pdf.source" @document-ready="onDocumentReady" @page-change="sourcePage=$event" @selection="selectOriginal" />
            </div>
            <form v-if="!mapped || readerTab === 'source'" class="reader-question" @submit.prevent="submitQuestion">
              <div v-if="selection" class="reader-quote">
                <span>{{ quotePage ? '原文第 ' + quotePage + ' 页选文' : '知识点选文' }}</span>
                <button type="button" aria-label="取消引用" @click="clearSelection">×</button>
                <div><SafeMarkdown inline :text="selection" /></div>
              </div>
              <label for="reader-question">{{ readerTab === 'source' ? '原文第 ' + sourcePage + ' 页提问' : '针对本节提问' }}</label>
              <textarea id="reader-question" ref="questionInput" v-model="draft" aria-label="新问题" placeholder="哪一步没理解？" rows="2" @keydown.meta.enter.prevent="submitQuestion" @keydown.ctrl.enter.prevent="submitQuestion" />
              <button type="submit" :disabled="!draft.trim()">提问 ↗</button>
            </form>
          </aside>
        </ResizableSidebar>
      </div>
    </main>
    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen=false" @keydown.esc="settingsOpen=false">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <div class="modal-head"><h2 id="ai-settings-title">AI 设置</h2><button type="button" aria-label="关闭 AI 设置" @click="settingsOpen=false">×</button></div>
        <p>在 Rove 项目根目录的 <code>.env</code> 中填写服务地址、模型名称和所需密钥。保存后回到 Rove，配置会自动刷新。</p>
        <label>服务地址<input readonly :value="aiConfig.baseUrl || '未填写'" /></label>
        <label>模型名称<input readonly :value="aiConfig.model || '未填写'" /></label>
        <p v-if="configError" role="alert">{{ configError }}</p>
        <div class="privacy-note">整理知识点或追问时，Rove 会将相关资料文本发送给此模型服务。</div>
        <button type="button" class="save-settings" @click="showEnvFile">在 Finder 中显示 .env</button>
      </section>
    </div>
  </div>
</template>
