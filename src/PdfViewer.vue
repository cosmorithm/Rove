<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { normalizePdfText, readPageText } from './pdfText'
import { pdfDocumentSource, type PdfSource } from './pdfSource'

const props = defineProps<{ source: PdfSource }>()
type ExtractedPage = { page: number; text: string }
const emit = defineEmits<{
  selection: [selection: ExtractedPage]
  'page-change': [page: number]
  'document-ready': [document: PDFDocumentProxy]
}>()
GlobalWorkerOptions.workerSrc = workerUrl
const assetBase = new URL(import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : './pdfjs/', document.baseURI).href
const canvas = ref<HTMLCanvasElement | null>(null)
const textLayerElement = ref<HTMLDivElement | null>(null)
const pageNumber = ref(1)
const pageCount = ref(0)
const scrollElement = ref<HTMLDivElement | null>(null)
const jumpInput = ref('1')
const zoom = ref(1)
const zoomLevels = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5]
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let displayedNumber = 0
const busy = ref(false)
const extraction = ref('')
const error = ref('')

let controller: AbortController | undefined
let loadingTask: PDFDocumentLoadingTask | undefined
let opening: Promise<void>
let doc: PDFDocumentProxy | undefined
let visiblePage: PDFPageProxy | undefined
let extractingPage: PDFPageProxy | undefined
let renderTask: RenderTask | undefined
let textLayer: TextLayer | undefined
let renderGeneration = 0
let lectureText: Promise<ExtractedPage[]> | undefined

// PDF.js can leave a pending worker request unresolved when its document is destroyed.
function untilClosed<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const canceled = () => reject(signal.reason)
    if (signal.aborted) { canceled(); return }
    signal.addEventListener('abort', canceled, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', canceled))
  })
}

async function renderPage() {
  const current = doc
  if (!current) return
  const id = ++renderGeneration
  const number = pageNumber.value
  const previousRender = renderTask
  previousRender?.cancel()
  textLayer?.cancel()
  try {
    if (previousRender) await previousRender.promise.catch(() => {})
    if (id !== renderGeneration) return
    if (visiblePage && visiblePage !== extractingPage && visiblePage.pageNumber !== number) visiblePage.cleanup()
    const page = await current.getPage(number)
    await nextTick()
    if (id !== renderGeneration || !canvas.value || !textLayerElement.value || !scrollElement.value) return
    const container = scrollElement.value
    const style = getComputedStyle(container)
    const width = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    if (width <= 0) return
    visiblePage = page
    const fit = width / page.getViewport({ scale: 1 }).width
    const viewport = page.getViewport({ scale: fit * zoom.value })
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (viewport.width * viewport.height)))
    const target = canvas.value
    target.width = Math.max(1, Math.floor(viewport.width * ratio))
    target.height = Math.max(1, Math.floor(viewport.height * ratio))
    target.style.width = `${viewport.width}px`
    target.style.height = `${viewport.height}px`
    const context = target.getContext('2d')
    if (!context) throw new Error('无法创建 PDF 画布')
    displayedNumber = number
    textLayerElement.value.replaceChildren()
    textLayerElement.value.style.width = `${viewport.width}px`
    textLayerElement.value.style.height = `${viewport.height}px`
    textLayerElement.value.style.setProperty('--scale-factor', String(viewport.scale))
    error.value = ''
    renderTask = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
    textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textLayerElement.value, viewport })
    await Promise.all([renderTask.promise, textLayer.render()])
  } catch (reason) {
    if (id !== renderGeneration || current !== doc) return
    error.value = `页面显示失败：${reason instanceof Error ? reason.message : '未知错误'}`
  }
}

async function extractText(current: PDFDocumentProxy, signal: AbortSignal) {
  const result: ExtractedPage[] = []
  // The caller includes page labels and sends at most 24,000 characters to the model.
  let remaining = 24_001
  try {
    for (let number = 1; number <= current.numPages && remaining > 0; number++) {
      if (current !== doc) throw new Error('已切换资料。')
      extraction.value = `正在读取文字 ${number}/${current.numPages} 页`
      const page = await current.getPage(number)
      if (current !== doc) throw new Error('已切换资料。')
      extractingPage = page
      let text: string
      try {
        text = await readPageText(page, signal, remaining)
      } finally {
        if (current === doc) {
          extractingPage = undefined
          if (page !== visiblePage && number !== pageNumber.value) page.cleanup()
        }
      }
      if (current !== doc) throw new Error('已切换资料。')
      if (text) {
        result.push({ page: number, text })
        remaining -= text.length + `[第 ${number} 页]\n`.length + (result.length > 1 ? 2 : 0)
      }
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    return result
  } finally {
    if (current === doc) extraction.value = ''
  }
}

async function extractForLecture() {
  const session = controller
  await opening
  if (!doc || !session || session !== controller || session.signal.aborted) throw new Error(error.value || 'PDF 尚未打开。')
  const current = doc
  lectureText ??= extractText(current, session.signal).catch(reason => {
    if (doc === current) lectureText = undefined
    throw reason
  })
  return untilClosed(lectureText, session.signal)
}
async function getCurrentPageText(): Promise<ExtractedPage> {
  const session = controller
  await opening
  if (!doc || !session || session !== controller || session.signal.aborted) throw new Error(error.value || 'PDF 尚未打开。')
  const number = pageNumber.value
  const page = await untilClosed(doc.getPage(number), session.signal)
  return { page: number, text: await readPageText(page, session.signal) }
}

function goToPage(number: number) {
  if (pageCount.value && Number.isFinite(number)) {
    pageNumber.value = Math.max(1, Math.min(Math.round(number), pageCount.value))
  }
  jumpInput.value = String(pageNumber.value)
}
function submitPage() {
  if (/^\d+$/.test(jumpInput.value.trim())) goToPage(Number(jumpInput.value))
  else jumpInput.value = String(pageNumber.value)
}
function changeZoom(step: number) {
  const next = zoomLevels.indexOf(zoom.value) + step
  zoom.value = zoomLevels[Math.max(0, Math.min(next, zoomLevels.length - 1))]
}
function captureSelection() {
  const selected = window.getSelection()
  const layer = textLayerElement.value
  if (!selected || !selected.rangeCount || selected.isCollapsed || !layer || displayedNumber !== pageNumber.value) return
  const range = selected.getRangeAt(0)
  if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return
  const text = normalizePdfText(selected.toString())
  if (text) emit('selection', { page: displayedNumber, text })
}
defineExpose({ extractForLecture, getCurrentPageText, goToPage })

function closePdf() {
  ++renderGeneration
  clearTimeout(resizeTimer)
  displayedNumber = 0
  const oldController = controller
  controller = undefined
  doc = undefined
  lectureText = undefined
  visiblePage = undefined
  extractingPage = undefined
  renderTask?.cancel()
  renderTask = undefined
  textLayer?.cancel()
  textLayer = undefined
  oldController?.abort()
  if (loadingTask) void loadingTask.destroy().catch(() => {})
  loadingTask = undefined
}

async function openPdf(source: PdfSource) {
  closePdf()
  const session = new AbortController()
  controller = session
  busy.value = true
  pageNumber.value = 1
  jumpInput.value = '1'
  zoom.value = 1
  pageCount.value = 0
  error.value = ''
  extraction.value = ''
  try {
    const input = await pdfDocumentSource(source, session)
    if (session !== controller) return
    const task = getDocument({
      ...input, cMapUrl: assetBase + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: assetBase + 'standard_fonts/', useWorkerFetch: false,
      isEvalSupported: false
    })
    loadingTask = task
    // Range transport errors can arrive after opening while reading another page.
    session.signal.addEventListener('abort', () => {
      if (session !== controller) return
      const reason = session.signal.reason
      error.value = `PDF 读取失败：${reason instanceof Error ? reason.message : '请重新导入。'}`
      closePdf()
      pageCount.value = 0
      extraction.value = ''
      busy.value = false
    }, { once: true })
    const loaded = await untilClosed(task.promise, session.signal)
    if (session !== controller) return
    doc = loaded
    pageCount.value = loaded.numPages
    emit('document-ready', loaded)
    emit('page-change', pageNumber.value)
    await nextTick()
    void renderPage()
  } catch (reason) {
    if (session === controller) {
      error.value = `无法打开 PDF：${reason instanceof Error ? reason.message : '文件无效或已损坏'}`
      closePdf()
      busy.value = false
    }
  } finally {
    if (session === controller) busy.value = false
  }
}

watch(() => props.source, source => { opening = openPdf(source) }, { immediate: true })
watch(pageNumber, number => {
  jumpInput.value = String(number)
  if (!doc) return
  emit('page-change', number)
  if (scrollElement.value) scrollElement.value.scrollTo(0, 0)
  void renderPage()
})
watch(zoom, () => void renderPage())
watch(scrollElement, (element, _, onCleanup) => {
  if (!element) return
  let width = element.clientWidth
  const observer = new ResizeObserver(() => {
    if (element.clientWidth === width) return
    width = element.clientWidth
    clearTimeout(resizeTimer)
    if (width > 0) resizeTimer = setTimeout(() => void renderPage(), 80)
  })
  observer.observe(element)
  onCleanup(() => { observer.disconnect(); clearTimeout(resizeTimer) })
}, { flush: 'post' })
onBeforeUnmount(closePdf)
</script>

<template>
  <section class="pdf-viewer" aria-label="PDF 阅读器">
    <div class="pdf-toolbar" v-if="pageCount">
      <form class="pdf-pages" @submit.prevent="submitPage">
        <button type="button" aria-label="上一页" title="上一页" :disabled="pageNumber <= 1" @click="goToPage(pageNumber-1)">‹</button>
        <input v-model="jumpInput" type="text" inputmode="numeric" aria-label="跳转到页码" title="输入页码并回车" @focus="($event.target as HTMLInputElement).select()" @change="submitPage" />
        <span>/ {{ pageCount }}</span>
        <button type="button" aria-label="下一页" title="下一页" :disabled="pageNumber >= pageCount" @click="goToPage(pageNumber+1)">›</button>
      </form>
      <div class="pdf-zoom" aria-label="缩放">
        <button type="button" aria-label="缩小" title="缩小" :disabled="zoom === zoomLevels[0]" @click="changeZoom(-1)">−</button>
        <button type="button" class="zoom-value" aria-label="适合宽度" title="恢复适宽显示" @click="zoom=1">{{ zoom === 1 ? '适宽' : Math.round(zoom * 100) + '%' }}</button>
        <button type="button" aria-label="放大" title="放大" :disabled="zoom === zoomLevels[zoomLevels.length - 1]" @click="changeZoom(1)">+</button>
      </div>
    </div>
    <p v-if="busy" class="pdf-message" role="status">正在打开 PDF…</p>
    <p v-if="error" class="pdf-message pdf-error" role="alert">{{ error }}</p>
    <p v-if="extraction" class="pdf-message" role="status">{{ extraction }}</p>
    <div v-if="pageCount" ref="scrollElement" class="pdf-scroll">
      <div class="pdf-sheet">
        <canvas ref="canvas" :aria-label="`PDF 第 ${pageNumber} 页`" />
        <div ref="textLayerElement" class="textLayer" @pointerup="captureSelection" @keyup="captureSelection" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.pdf-viewer { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; height: 100%; color: #475448; background: #e9ebe6; overflow: hidden; }
.pdf-toolbar { display: flex; flex: none; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; padding: 7px 14px; background: #fcfcfa; border-bottom: 1px solid #dce1d9; font-size: 12px; }
.pdf-pages, .pdf-zoom { display: flex; align-items: center; gap: 4px; margin: 0; }
.pdf-toolbar button, .pdf-pages input { border: 1px solid transparent; border-radius: 5px; color: inherit; background: transparent; height: 27px; }
.pdf-toolbar button { min-width: 26px; font: inherit; font-size: 17px; line-height: 1; cursor: pointer; }
.pdf-toolbar button:hover:not(:disabled) { background: #e9eee8; }
.pdf-toolbar button:disabled { opacity: .3; }
.pdf-toolbar .zoom-value { font-size: 12px; min-width: 45px; }
.pdf-pages input { width: 40px; border-color: #d9ded6; background: white; text-align: center; font: inherit; }
.pdf-message { margin: 9px 16px; font-size: 12px; }
.pdf-error { color: #a14d3d; }
.pdf-scroll { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px clamp(8px, 1.3vw, 22px) 24px; overscroll-behavior: contain; }
.pdf-sheet { position: relative; width: max-content; margin-inline: auto; background: white; box-shadow: 0 1px 8px #28362926; }
.pdf-sheet canvas { display: block; }
.pdf-sheet .textLayer { position: absolute; inset: 0; cursor: text; }
</style>
