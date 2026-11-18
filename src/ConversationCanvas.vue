<script setup lang="ts">
import { inject, type Ref, computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import type { Block } from './library'
import { answerText, cardTitle, type Card } from './types'
import SafeMarkdown from './SafeMarkdown.vue'
import type { AppearanceSettings } from './appearance'
import { createCanvasPan } from './canvasPan'
import { createCanvasNodeDrag } from './canvasNodeDrag'
import { clampCanvasPoint, readCanvasPositions, resolveCanvasLayout, saveCanvasPositions, type CanvasPoint } from './canvasLayout'

const props = withDefaults(defineProps<{ blocks: Block[]; layoutKey: string; selectedId?: string; selectedBlockId?: string; documentName: string; title?: string; rootLabel?: string; commits?: Record<string, string>; editableAnswers?: boolean }>(), {
  title: '对话地图', rootLabel: '话题'
})
const emit = defineEmits<{ select: [id: string]; read: [blockId: string]; start: [blockId?: string]; edit: [id: string, anchor: HTMLElement] }>()
const scroller = ref<HTMLElement>()
const plane = ref<HTMLElement>()
const positions = ref(readCanvasPositions(props.layoutKey))
const layoutError = ref('')
const draggedKey = ref<string>()
const panning = ref(false)
const pan = createCanvasPan(active => { panning.value = active })
const scale = ref(1)
const focused = ref('')
const nodeButtons = new Map<string, HTMLButtonElement>()
const appearance = inject<Ref<AppearanceSettings> | undefined>('rove-appearance', undefined)
const columnGap = 56, rowGap = 30, margin = 40

function chapterTitle(block: Block) {
  return props.blocks.length === 1 && block.title === '准备开始学习' ? '整份资料' : summary(block.title)
}

interface MapNode {
  key: string
  block: Block
  card?: Card
  parent?: MapNode
  children: MapNode[]
  x: number
  y: number
  width: number
  height: number
}

const autoNodes = computed(() => {
  const fontScale = (appearance?.value.fontSize ?? 15) / 14
  const cardWidth = Math.ceil(244 * fontScale), cardHeight = Math.ceil(124 * fontScale)
  const chapterWidth = Math.ceil(194 * fontScale), chapterHeight = Math.ceil(94 * fontScale)
  const nodes: MapNode[] = []
  let top = margin, bottom = 0, emptyColumn = 0
  for (const block of props.blocks) {
    const chapter: MapNode = { key: 'b/' + block.id, block, children: [], x: margin, y: 0, width: chapterWidth, height: chapterHeight }
    if (!block.cards?.length) {
      // Pack consecutive standalone knowledge points into rows while preserving reading order.
      chapter.x += emptyColumn * (chapterWidth + 16)
      chapter.y = top
      nodes.push(chapter)
      bottom = Math.max(bottom, chapter.y + chapter.height)
      emptyColumn = (emptyColumn + 1) % 3
      if (!emptyColumn) top = bottom + rowGap
      continue
    }
    if (emptyColumn) { top = bottom + rowGap; emptyColumn = 0 }
    const stack = [chapter], ordered: MapNode[] = []
    while (stack.length) {
      const node = stack.pop()!
      ordered.push(node)
      const cards = node.card ? node.card.children ?? [] : block.cards
      for (const card of cards) {
        node.children.push({ key: 'q/' + card.id, card, block, parent: node, children: [],
          x: node.x + node.width + columnGap, y: 0, width: cardWidth, height: cardHeight })
      }
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
      if (!node.children.length) {
        node.y = top
        top += cardHeight + rowGap
      }
    }
    // Parents sit halfway between their first and last child, including nested forks.
    for (let i = ordered.length - 1; i >= 0; i--) {
      const node = ordered[i], children = node.children
      if (children.length) {
        const first = children[0], last = children[children.length - 1]
        node.y = (first.y + first.height / 2 + last.y + last.height / 2 - node.height) / 2
      }
      bottom = Math.max(bottom, node.y + node.height)
    }
    for (const node of ordered) nodes.push(node)
    top += 22
  }
  return nodes
})
const graph = computed(() => ({
  nodes: autoNodes.value,
  ...resolveCanvasLayout(autoNodes.value.map(node => ({ key: node.key, x: node.x, y: node.y,
    width: node.width, height: node.height, parentKey: node.parent?.key })), positions.value, margin),
}))
const hasManualLayout = computed(() => autoNodes.value.some(node => !!positions.value[node.key]))

function persistLayout() {
  layoutError.value = saveCanvasPositions(props.layoutKey, positions.value) ? '' : '节点位置已调整，但本地保存失败，重启后可能丢失。'
}
function freezeLayout() {
  // Pin the existing arrangement before moving one node, so its children and siblings stay put.
  positions.value = { ...positions.value, ...graph.value.positions }
}
function moveNode(key: string, point: CanvasPoint) {
  positions.value[key] = clampCanvasPoint(point)
}
const nodeDrag = createCanvasNodeDrag({
  position: key => graph.value.positions[key],
  point: event => {
    const bounds = plane.value?.getBoundingClientRect()
    if (!bounds) return
    return { x: (event.clientX - bounds.left) / scale.value + graph.value.minX,
      y: (event.clientY - bounds.top) / scale.value + graph.value.minY }
  },
  onStart: freezeLayout,
  onMove: moveNode,
  onEnd: persistLayout,
  onActive: key => { draggedKey.value = key },
})
function startNodeDrag(event: PointerEvent, node: MapNode) {
  pan.cancel()
  nodeDrag.start(event, node.key)
}
function startPan(event: PointerEvent) {
  if (!nodeDrag.active) pan.start(event)
}
function cancelGestures() {
  pan.cancel()
  nodeDrag.cancel()
}
function moveGesture(event: PointerEvent) {
  nodeDrag.move(event)
  pan.move(event)
}
function finishGesture(event: PointerEvent) {
  nodeDrag.finish(event)
  pan.finish(event)
}
function clickNode(event: MouseEvent, node: MapNode) {
  if (nodeDrag.consumeClick(event, node.key)) return
  if (node.card) emit('select', node.card.id)
  else emit('read', node.block.id)
}
async function resetLayout() {
  cancelGestures()
  positions.value = {}
  persistLayout()
  await nextTick()
  fit()
}

function summary(value = '') {
  // Shorten prose only between formula tokens so a preview never contains half a formula.
  const math = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|(?<![\\$])\$(?![\s$])((?:\\.|[^\n\\$])+?)(?<!\s)\$(?!\$)/g
  const pieces: string[] = []
  let left = 130, last = 0
  function prose(s: string) {
    const plain = s.replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/g, ' ').replace(/\s+/g, ' ')
    pieces.push(plain.slice(0, left))
    left -= Math.min(left, plain.length)
    return plain.length > 0 && left === 0
  }
  for (const match of value.matchAll(math)) {
    if (prose(value.slice(last, match.index))) return pieces.join('').trim() + '…'
    const tex = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim()
    const compact = tex.length <= 64 && !tex.includes('\n') && !/\\begin\b/.test(tex)
    pieces.push(compact ? '\\(' + tex + '\\)' : '（公式）')
    left = Math.max(0, left - (compact ? tex.length : 4))
    last = match.index + match[0].length
    if (!left) break
  }
  const shortened = prose(value.slice(last))
  return pieces.join('').trim() + (shortened ? '…' : '')
}

function preserveButton(key: string, element: unknown) {
  if (element) nodeButtons.set(key, element as HTMLButtonElement)
  else nodeButtons.delete(key)
}
async function focusNode(key: string, keyboard = false) {
  await nextTick()
  const button = nodeButtons.get(key)
  if (!button) return
  if (keyboard) button.focus({ preventScroll: true })
  button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
const tabStop = computed(() => {
  const nodes = graph.value.nodes
  return nodes.find(n => n.key === focused.value)?.key
    ?? revealKey.value
})
const currentKey = computed(() => props.selectedId ? 'q/' + props.selectedId : props.selectedBlockId ? 'b/' + props.selectedBlockId : '')
const revealKey = computed(() => {
  const nodes = graph.value.nodes
  return nodes.find(n => n.key === currentKey.value)?.key
    ?? nodes.find(n => !!n.card)?.key ?? nodes[0]?.key
})
function navigate(event: KeyboardEvent, node: MapNode) {
  if (event.key === 'F2' && canEdit(node)) {
    event.preventDefault()
    openNodeEditor(node)
    return
  }
  if (event.altKey) {
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const offset = offsets[event.key]
    if (offset) {
      event.preventDefault()
      cancelGestures()
      const point = graph.value.positions[node.key], step = event.shiftKey ? 64 : 16
      freezeLayout()
      moveNode(node.key, { x: point.x + offset[0] * step, y: point.y + offset[1] * step })
      persistLayout()
      return
    }
  }
  const siblings = node.parent?.children ?? graph.value.nodes.filter(n => !n.parent)
  const index = siblings.indexOf(node)
  let target: MapNode | undefined
  switch (event.key) {
    case 'ArrowRight': target = node.children[0]; break
    case 'ArrowLeft': target = node.parent; break
    case 'ArrowDown': target = siblings[index + 1]; break
    case 'ArrowUp': target = siblings[index - 1]; break
    case 'Home': target = graph.value.nodes[0]; break
    case 'End': target = graph.value.nodes.at(-1); break
    default: return
  }
  event.preventDefault()
  if (target) void focusNode(target.key, true)
}

function canEdit(node: MapNode) {
  return props.editableAnswers && node.card && !node.children.length && !node.card.loading && !node.card.chatBusy
}
const selectedEditableNode = computed(() => {
  if (!props.editableAnswers || !props.selectedId) return
  return graph.value.nodes.find(node => node.card?.id === props.selectedId && canEdit(node))
})
function openNodeEditor(node: MapNode) {
  const anchor = nodeButtons.get(node.key)
  if (anchor && node.card && canEdit(node)) emit('edit', node.card.id, anchor)
}

async function zoom(next: number, center = true) {
  cancelGestures()
  const view = scroller.value
  if (!view) return
  // One viewport of space surrounds the graph so even a small map can be dragged.
  const width = view.clientWidth, height = Math.max(1, view.clientHeight - 32)
  const old = scale.value
  const x = (view.scrollLeft + width / 2 - width) / old
  const y = (view.scrollTop + height / 2 - height) / old
  scale.value = Math.min(1.8, Math.max(0.001, next))
  await nextTick()
  if (scroller.value !== view) return
  view.scrollLeft = width + (center ? x * scale.value - width / 2 : Math.min(0, (graph.value.width * scale.value - width) / 2))
  view.scrollTop = height + (center ? y * scale.value - height / 2 : Math.min(0, (graph.value.height * scale.value - height) / 2))
}
function fit() {
  const view = scroller.value
  if (view) void zoom(Math.min(1, view.clientWidth / graph.value.width, Math.max(1, view.clientHeight - 32) / graph.value.height), false)
}
function revealSelection() {
  if (revealKey.value) void focusNode(revealKey.value)
}
onMounted(() => {
  // Keep tracking when a pointer crosses another node or a sidebar/scrollbar during a drag.
  window.addEventListener('pointermove', moveGesture, true)
  window.addEventListener('pointerup', finishGesture, true)
  window.addEventListener('pointercancel', finishGesture, true)
  window.addEventListener('blur', cancelGestures)
})
onDeactivated(cancelGestures)
onBeforeUnmount(() => {
  cancelGestures()
  window.removeEventListener('pointermove', moveGesture, true)
  window.removeEventListener('pointerup', finishGesture, true)
  window.removeEventListener('pointercancel', finishGesture, true)
  window.removeEventListener('blur', cancelGestures)
})
watch(() => [graph.value.minX, graph.value.minY], async ([x, y], [oldX, oldY]) => {
  const view = scroller.value
  if (!view || x === oldX && y === oldY) return
  const left = view.scrollLeft + (oldX - x) * scale.value
  const top = view.scrollTop + (oldY - y) * scale.value
  await nextTick()
  if (scroller.value !== view) return
  // Growing the scene to the left/top must not move the other nodes on screen.
  view.scrollLeft = left
  view.scrollTop = top
})
watch(scroller, async (view, previous, onCleanup) => {
  cancelGestures()
  if (!view) return
  let width = view.clientWidth, height = view.clientHeight
  const observer = new ResizeObserver(() => {
    if (!view.clientWidth || !view.clientHeight) return
    // Keep the same map point at the viewport center when a sidebar or window is resized.
    view.scrollLeft += (view.clientWidth - width) / 2
    view.scrollTop += (view.clientHeight - height) / 2
    width = view.clientWidth; height = view.clientHeight
    cancelGestures()
  })
  observer.observe(view)
  onCleanup(() => observer.disconnect())
  await zoom(scale.value, false)
  revealSelection()
}, { flush: 'post' })
watch(revealKey, revealSelection)
watch(() => props.documentName, async () => { focused.value = ''; await zoom(1, false); revealSelection() })
</script>

<template>
  <section class="conversation-canvas" :aria-label="documentName + ' · ' + title">
    <header class="canvas-bar">
      <div class="canvas-location"><h2>{{ title }}</h2></div>
      <div class="canvas-tools">
        <slot name="actions" />
        <button v-if="selectedEditableNode" type="button" class="toolbar-edit" @click="openNodeEditor(selectedEditableNode)">编辑回答</button>
        <button type="button" class="layout-reset" :disabled="!hasManualLayout" title="清除手动位置，恢复自动排布" @click="resetLayout">自动布局</button>
        <button type="button" class="new-question" @click="emit('start')"><span aria-hidden="true">＋</span>新提问</button>
      </div>
    </header>
    <p v-if="layoutError" class="canvas-layout-error" role="status">{{ layoutError }}</p>
    <div v-if="!graph.nodes.length" class="canvas-empty">
      <p>暂无话题</p>
    </div>
    <div v-else ref="scroller" class="canvas-scroll" :class="{ 'is-panning': panning, 'is-node-dragging': !!draggedKey }"
      @pointerdown="startPan" @lostpointercapture="pan.finish">
      <div class="canvas-extent" :style="{ width: 'calc(200% + ' + graph.width * scale + 'px)', height: 'calc(200% + ' + graph.height * scale + 'px)' }">
        <div ref="plane" class="canvas-plane" :style="{width:graph.width+'px',height:graph.height+'px',left:'calc(50% - '+graph.width*scale/2+'px)',top:'calc(50% - '+graph.height*scale/2+'px)',transform:'scale('+scale+')'}">
          <svg class="canvas-edges" :width="graph.width" :height="graph.height" aria-hidden="true">
            <path v-for="edge in graph.links" :key="edge.key" :data-child="edge.child" :d="edge.path" :class="{ current: 'q/' + selectedId === edge.child }" />
          </svg>
          <template v-for="node in graph.nodes" :key="node.key">
            <button :ref="el=>preserveButton(node.key,el)"
              type="button" class="canvas-node" title="单击查看，拖动调整位置；Alt + 方向键微调位置" :class="[node.card ? 'exchange-node' : 'chapter-node', { 'has-children': node.children.length, 'is-loading': node.card?.loading || node.card?.chatBusy, 'is-dragging': draggedKey === node.key }]"
              :aria-keyshortcuts="canEdit(node) ? 'F2 Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown'"
              :data-node="node.key" :data-map-id="node.card?.id" :data-block-id="!node.card ? node.block.id : undefined" :aria-current="node.key === currentKey ? 'location' : undefined"
              :tabindex="tabStop === node.key ? 0 : -1"
              :style="{left:(graph.positions[node.key].x-graph.minX)+'px',top:(graph.positions[node.key].y-graph.minY)+'px',width:node.width+'px',height:node.height+'px'}"
              @pointerdown="startNodeDrag($event,node)" @lostpointercapture="nodeDrag.finish" @dragstart.prevent
              @focus="focused=node.key" @keydown="navigate($event,node)"
              @click="clickNode($event,node)">
              <template v-if="node.card">
                <span class="node-question" :title="node.card.question"><template v-if="node.card.studyContext?.title?.trim()">{{ cardTitle(node.card) }}</template><SafeMarkdown v-else inline :text="summary(node.card.question) || '未命名提问'" /></span>
                <span class="node-answer"><SafeMarkdown inline :text="node.card.loading ? '正在回答…' : summary(answerText(node.card)) || '暂无回答'" /></span>
                <small v-if="commits?.[node.card.id]" class="node-commit">{{ commits[node.card.id].slice(0, 8) }}</small>
              </template>
              <template v-else>
                <span class="chapter-label">{{ rootLabel }}</span>
                <span class="node-question"><SafeMarkdown inline :text="chapterTitle(node.block)" /></span>
                <span class="chapter-read" aria-hidden="true">↗</span><span class="canvas-sr">阅读此节</span>
              </template>
            </button>
            <button v-if="canEdit(node)" type="button" class="canvas-edit" aria-label="编辑节点回答" title="编辑节点回答（F2）"
              :tabindex="tabStop === node.key ? 0 : -1"
              :style="{left:(graph.positions[node.key].x-graph.minX+node.width-8)+'px',top:(graph.positions[node.key].y-graph.minY+8)+'px'}"
              @pointerdown.stop @click.stop="openNodeEditor(node)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12z" /></svg>
              <span>编辑</span>
            </button>
          </template>
        </div>
      </div>
    </div>
    <div v-if="graph.nodes.length" class="canvas-navigation">
      <div class="zoom-tools" aria-label="地图缩放">
        <button type="button" aria-label="缩小" title="缩小" :disabled="scale <= .12" @click="zoom(Math.max(.12, scale / 1.2))">−</button>
        <button type="button" class="zoom-value" aria-label="恢复原始大小" title="恢复原始大小" @click="zoom(1)">{{ Math.round(scale * 100) }}%</button>
        <button type="button" aria-label="放大" title="放大" :disabled="scale >= 1.8" @click="zoom(scale * 1.2)">+</button>
      </div>
      <button type="button" class="fit-tool" title="让整张地图适应视图" @click="fit">适应视图</button>
    </div>
  </section>
</template>

<style scoped>
.conversation-canvas {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  height: 100%;
  color: var(--rove-text);
  background: var(--rove-canvas);
}
.canvas-bar {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  flex: none;
  gap: 10px 16px;
  padding: 20px 26px 12px;
  background: var(--rove-canvas);
}
.canvas-location, .canvas-tools, .zoom-tools, .canvas-navigation {
  display: flex;
  align-items: center;
}
.canvas-location { flex: 1; min-width: 0; }
.canvas-location h2 {
  margin: 0;
  color: var(--rove-muted);
  font-size: calc(12px * var(--rove-font-scale, 1));
  font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650);
  line-height: 1.5;
  letter-spacing: .02em;
}
.canvas-tools { flex-wrap: wrap; gap: 8px; }
.canvas-bar button, .canvas-navigation button {
  border: 1px solid var(--rove-line);
  border-radius: 8px;
  background: var(--rove-surface);
  color: var(--rove-accent-strong);
  font-family: var(--rove-font-family);
  font-size: calc(12px * var(--rove-font-scale, 1));
  line-height: 1.4;
  font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650);
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.canvas-bar button:hover, .canvas-navigation button:hover { background: var(--rove-rail); }
.canvas-bar button:disabled, .canvas-navigation button:disabled { opacity: .35; cursor: default; }
.canvas-bar .new-question {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 32px;
  padding: 5px 12px 5px 9px;
  color: #fff;
  border-color: var(--rove-accent);
  background: var(--rove-accent-strong);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--rove-text) 8.6%, transparent), inset 0 1px 0 color-mix(in srgb, var(--rove-surface) 10.2%, transparent);
}
.new-question span { font-size: calc(17px * var(--rove-font-scale, 1)); font-weight: var(--rove-font-weight, 450); line-height: 1; }
.canvas-bar .new-question:hover { background: var(--rove-accent-strong); border-color: var(--rove-accent); }
.canvas-scroll, .canvas-empty {
  overflow: auto;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overscroll-behavior: contain;
  background-image: radial-gradient(color-mix(in srgb, var(--rove-muted) 28%, transparent) .65px, transparent .85px);
  background-size: 24px 24px;
  background-position: 12px 12px;
}
.canvas-layout-error { flex: none; margin: 0; padding: 6px 26px; color: var(--rove-secondary); font-size: calc(12px * var(--rove-font-scale, 1)); }
.layout-reset, .toolbar-edit { min-height: 32px; padding: 5px 10px; }
.canvas-scroll { display: flex; padding-bottom: 32px; cursor: grab; background-attachment: local; overflow-anchor: none; -webkit-app-region: no-drag; }
.canvas-scroll.is-panning, .canvas-scroll.is-panning *, .canvas-scroll.is-node-dragging, .canvas-scroll.is-node-dragging * { cursor: grabbing; user-select: none; }
.canvas-extent { flex: none; margin: auto; position: relative; overflow: visible; }
.canvas-plane { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.canvas-edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  fill: none;
  stroke: color-mix(in srgb, var(--rove-accent) 35%, var(--rove-line));
  stroke-width: 1.4;
}
.canvas-edges .current { stroke: var(--rove-accent); stroke-width: 1.8; }
.canvas-node {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  padding: 16px 18px;
  text-align: left;
  color: var(--rove-text);
  border: 1px solid var(--rove-line);
  border-radius: 13px;
  background: var(--rove-surface);
  box-shadow: 0 2px 3px color-mix(in srgb, var(--rove-text) 1.2%, transparent), 0 6px 14px color-mix(in srgb, var(--rove-text) 2%, transparent);
  cursor: grab;
  touch-action: none;
  user-select: none;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.canvas-node.is-dragging { z-index: 2; border-color: var(--rove-accent); }
.canvas-edit {
  position: absolute;
  transform: translateX(-100%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 3px 8px;
  border: 1px solid var(--rove-line);
  border-radius: 7px;
  background: var(--rove-accent-soft);
  color: var(--rove-accent-strong);
  font: 600 calc(12px * var(--rove-font-scale, 1))/1.4 var(--rove-font-family);
  white-space: nowrap;
  cursor: pointer;
}
.canvas-node:has(+ .canvas-edit) .node-question { padding-inline-end: calc(2em + 25px); }
.canvas-edit:hover { border-color: var(--rove-accent); }
.canvas-node:hover { border-color: var(--rove-accent); box-shadow: 0 3px 5px color-mix(in srgb, var(--rove-text) 2.4%, transparent), 0 8px 20px color-mix(in srgb, var(--rove-text) 3.9%, transparent); }
.canvas-node[aria-current] {
  background: var(--rove-surface);
  border-color: var(--rove-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--rove-accent) 7.1%, transparent), 0 5px 18px color-mix(in srgb, var(--rove-text) 6.3%, transparent);
}
.exchange-node::before, .has-children::after {
  content: '';
  position: absolute;
  top: calc(50% - 3px);
  width: 6px;
  height: 6px;
  border: 1px solid var(--rove-line);
  border-radius: 50%;
  background: var(--rove-surface);
}
.exchange-node::before { left: -4px; }
.has-children::after { right: -4px; }
.canvas-node[aria-current]::before, .canvas-node[aria-current]::after { border-color: var(--rove-accent); background: var(--rove-accent-strong); }
.canvas-node:focus-visible, .canvas-edit:focus-visible, .canvas-bar button:focus-visible, .canvas-navigation button:focus-visible {
  outline: 2px solid var(--rove-accent);
  outline-offset: 3px;
}
.node-question, .node-answer {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.node-question { color: var(--rove-text); font-size: calc(13px * var(--rove-font-scale, 1)); font-weight: 600; line-height: 1.5; letter-spacing: -.01em; }
.node-answer { color: var(--rove-secondary); font-size: calc(12px * var(--rove-font-scale, 1)); font-weight: var(--rove-font-weight, 450); line-height: 1.55; }
.node-commit { color: var(--rove-secondary); font: calc(11px * var(--rove-font-scale, 1))/1.3 ui-monospace, SFMono-Regular, monospace; }
.canvas-node:has(.node-commit) .node-question { -webkit-line-clamp: 1; }
.is-loading .node-answer { color: var(--rove-accent); }
.chapter-node {
  padding: 16px 24px 16px 18px;
  color: var(--rove-text);
  background: var(--rove-accent-soft);
  border-color: var(--rove-line);
  box-shadow: 0 2px 5px color-mix(in srgb, var(--rove-accent) 2.4%, transparent), 0 7px 18px color-mix(in srgb, var(--rove-accent) 2.4%, transparent);
}
.chapter-node:hover { background: var(--rove-accent-soft); border-color: var(--rove-accent); }
.chapter-node[aria-current] {
  background: var(--rove-accent-soft);
  border-color: var(--rove-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--rove-accent) 8.6%, transparent), 0 6px 20px color-mix(in srgb, var(--rove-accent) 4.3%, transparent);
}
.chapter-node .node-question { color: var(--rove-text); font-size: calc(14px * var(--rove-font-scale, 1)); line-height: 1.45; }
.chapter-label { color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1; font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650); }
.chapter-read { position: absolute; right: 12px; top: 11px; color: var(--rove-secondary); font-size: calc(14px * var(--rove-font-scale, 1)); }
.canvas-navigation {
  position: absolute;
  z-index: 3;
  bottom: 20px;
  left: 22px;
  gap: 1px;
  padding: 4px;
  border: 1px solid var(--rove-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--rove-surface) 92.9%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 2px 5px color-mix(in srgb, var(--rove-text) 2%, transparent), 0 5px 16px color-mix(in srgb, var(--rove-text) 3.1%, transparent);
}
.zoom-tools { gap: 1px; }
.canvas-navigation button { height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; }
.zoom-tools button { min-width: 26px; font-size: calc(16px * var(--rove-font-scale, 1)); font-weight: var(--rove-font-weight, 450); }
.zoom-tools .zoom-value { min-width: 46px; color: var(--rove-secondary); font-variant-numeric: tabular-nums; font-size: calc(11px * var(--rove-font-scale, 1)); }
.canvas-navigation .fit-tool { margin-left: 4px; padding-left: 12px; border-left: 1px solid var(--rove-line); border-radius: 0 5px 5px 0; font-size: calc(11px * var(--rove-font-scale, 1)); }
.canvas-empty { display: grid; place-items: center; padding: 30px; color: var(--rove-muted); font-size: calc(13px * var(--rove-font-scale, 1)); }
.canvas-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1080px) {
  .canvas-bar { padding: 16px 18px 10px; }
  .canvas-navigation { left: 16px; bottom: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .canvas-node, .canvas-bar button, .canvas-navigation button { transition: none; }
}
</style>
