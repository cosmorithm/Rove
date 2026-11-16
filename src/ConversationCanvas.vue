<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Block } from './library'
import { answerText, cardTitle, type Card } from './types'
import SafeMarkdown from './SafeMarkdown.vue'

const props = withDefaults(defineProps<{ blocks: Block[]; selectedId?: string; selectedBlockId?: string; documentName: string; title?: string; rootLabel?: string; commits?: Record<string, string> }>(), {
  title: '对话地图', rootLabel: '话题'
})
const emit = defineEmits<{ select: [id: string]; read: [blockId: string]; start: [blockId?: string] }>()
const scroller = ref<HTMLElement>()
const scale = ref(1)
const focused = ref('')
const nodeButtons = new Map<string, HTMLButtonElement>()
const cardWidth = 244, cardHeight = 124, chapterWidth = 194, chapterHeight = 94
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

const graph = computed(() => {
  const nodes: MapNode[] = []
  const links: { key: string; path: string; child: string }[] = []
  let top = margin, width = 0, bottom = 0, emptyColumn = 0
  for (const block of props.blocks) {
    const chapter: MapNode = { key: 'b/' + block.id, block, children: [], x: margin, y: 0, width: chapterWidth, height: chapterHeight }
    if (!block.cards?.length) {
      // Pack consecutive standalone knowledge points into rows while preserving reading order.
      chapter.x += emptyColumn * (chapterWidth + 16)
      chapter.y = top
      nodes.push(chapter)
      width = Math.max(width, chapter.x + chapter.width)
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
      for (const child of children) {
        const x = node.x + node.width, y = node.y + node.height / 2
        const end = child.y + child.height / 2, mid = x + columnGap / 2
        links.push({ key: child.key, child: child.card!.id, path: `M ${x} ${y} C ${mid} ${y} ${mid} ${end} ${child.x} ${end}` })
      }
      width = Math.max(width, node.x + node.width)
      bottom = Math.max(bottom, node.y + node.height)
    }
    for (const node of ordered) nodes.push(node)
    top += 22
  }
  return { nodes, links, width: width + margin, height: bottom + margin }
})

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

async function zoom(next: number, center = true) {
  const view = scroller.value
  if (!view) return
  const old = scale.value
  const x = (view.scrollLeft + view.clientWidth / 2) / old
  const y = (view.scrollTop + view.clientHeight / 2) / old
  scale.value = Math.min(1.8, Math.max(0.001, next))
  await nextTick()
  view.scrollLeft = center ? x * scale.value - view.clientWidth / 2 : 0
  view.scrollTop = center ? y * scale.value - view.clientHeight / 2 : 0
}
function fit() {
  const view = scroller.value
  if (view) void zoom(Math.min(1, view.clientWidth / graph.value.width, Math.max(1, view.clientHeight - 32) / graph.value.height), false)
}
function revealSelection() {
  if (revealKey.value) void focusNode(revealKey.value)
}
onMounted(revealSelection)
watch(revealKey, revealSelection)
watch(() => props.documentName, async () => { focused.value = ''; await zoom(1, false); revealSelection() })
</script>

<template>
  <section class="conversation-canvas" :aria-label="documentName + ' · ' + title">
    <header class="canvas-bar">
      <div class="canvas-location"><h2>{{ title }}</h2></div>
      <div class="canvas-tools">
        <slot name="actions" />
        <button type="button" class="new-question" @click="emit('start')"><span aria-hidden="true">＋</span>新提问</button>
      </div>
    </header>
    <div v-if="!graph.nodes.length" class="canvas-empty">
      <p>暂无话题</p>
    </div>
    <div v-else ref="scroller" class="canvas-scroll">
      <div class="canvas-extent" :style="{ width: graph.width * scale + 'px', height: graph.height * scale + 'px' }">
        <div class="canvas-plane" :style="{width:graph.width+'px',height:graph.height+'px',transform:'scale('+scale+')'}">
          <svg class="canvas-edges" :width="graph.width" :height="graph.height" aria-hidden="true">
            <path v-for="edge in graph.links" :key="edge.key" :d="edge.path" :class="{ current: selectedId === edge.child }" />
          </svg>
          <button v-for="node in graph.nodes" :key="node.key" :ref="el=>preserveButton(node.key,el)"
            type="button" class="canvas-node" :class="[node.card ? 'exchange-node' : 'chapter-node', { 'has-children': node.children.length, 'is-loading': node.card?.loading || node.card?.chatBusy }]"
            :data-node="node.key" :data-map-id="node.card?.id" :data-block-id="!node.card ? node.block.id : undefined" :aria-current="node.key === currentKey ? 'location' : undefined"
            :tabindex="tabStop === node.key ? 0 : -1"
            :style="{left:node.x+'px',top:node.y+'px',width:node.width+'px',height:node.height+'px'}"
            @focus="focused=node.key" @keydown="navigate($event,node)"
            @click="node.card ? emit('select',node.card.id) : emit('read',node.block.id)">
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
  color: var(--rove-text, #383342);
  background: var(--rove-canvas, #f8f7fc);
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
  background: var(--rove-canvas, #f8f7fc);
}
.canvas-location, .canvas-tools, .zoom-tools, .canvas-navigation {
  display: flex;
  align-items: center;
}
.canvas-location { flex: 1; min-width: 0; }
.canvas-location h2 {
  margin: 0;
  color: var(--rove-muted, #82778e);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: .02em;
}
.canvas-tools { gap: 8px; }
.canvas-bar button, .canvas-navigation button {
  border: 1px solid var(--rove-line, #e8e2ee);
  border-radius: 8px;
  background: var(--rove-surface, #fff);
  color: #5f5469;
  font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.canvas-bar button:hover, .canvas-navigation button:hover { background: #f3eff9; }
.canvas-bar button:disabled, .canvas-navigation button:disabled { opacity: .35; cursor: default; }
.canvas-bar .new-question {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 32px;
  padding: 5px 12px 5px 9px;
  color: #fff;
  border-color: var(--rove-accent, #80649f);
  background: var(--rove-accent-strong, #756095);
  box-shadow: 0 1px 2px #2a252f16, inset 0 1px 0 #ffffff1a;
}
.new-question span { font-size: 17px; font-weight: 400; line-height: 1; }
.canvas-bar .new-question:hover { background: #6f558c; border-color: #6f558c; }
.canvas-scroll, .canvas-empty {
  overflow: auto;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overscroll-behavior: contain;
  background-image: radial-gradient(#bab1c277 .65px, transparent .85px);
  background-size: 24px 24px;
  background-position: 12px 12px;
}
.canvas-scroll { display: flex; padding-bottom: 32px; }
.canvas-extent { flex: none; margin: auto; position: relative; overflow: visible; }
.canvas-plane { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.canvas-edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  fill: none;
  stroke: #d1c6dd;
  stroke-width: 1.4;
}
.canvas-edges .current { stroke: #a18aba; stroke-width: 1.8; }
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
  color: var(--rove-text, #383342);
  border: 1px solid #e0d5ea;
  border-radius: 13px;
  background: var(--rove-surface, #fff);
  box-shadow: 0 2px 3px #2f293403, 0 6px 14px #2f293405;
  cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.canvas-node:hover { border-color: #baa9ce; box-shadow: 0 3px 5px #2f293406, 0 8px 20px #2f29340a; }
.canvas-node[aria-current] {
  background: #fefcff;
  border-color: var(--rove-accent, #80649f);
  box-shadow: 0 0 0 3px #80649f12, 0 5px 18px #3a334110;
}
.exchange-node::before, .has-children::after {
  content: '';
  position: absolute;
  top: calc(50% - 3px);
  width: 6px;
  height: 6px;
  border: 1px solid #d1c6dd;
  border-radius: 50%;
  background: var(--rove-surface, #fff);
}
.exchange-node::before { left: -4px; }
.has-children::after { right: -4px; }
.canvas-node[aria-current]::before, .canvas-node[aria-current]::after { border-color: #9577b5; background: #b49ecb; }
.canvas-node:focus-visible, .canvas-bar button:focus-visible, .canvas-navigation button:focus-visible {
  outline: 2px solid var(--rove-accent, #80649f);
  outline-offset: 3px;
}
.node-question, .node-answer {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.node-question { color: #3a3440; font-size: 13px; font-weight: 600; line-height: 1.5; letter-spacing: -.01em; }
.node-answer { color: #81758c; font-size: 12px; font-weight: 400; line-height: 1.55; }
.node-commit { color: #84788f; font: 10px/1.3 ui-monospace, SFMono-Regular, monospace; }
.canvas-node:has(.node-commit) .node-question { -webkit-line-clamp: 1; }
.is-loading .node-answer { color: var(--rove-accent, #80649f); }
.chapter-node {
  padding: 16px 24px 16px 18px;
  color: #59466e;
  background: #eee8f7;
  border-color: #ded3ec;
  box-shadow: 0 2px 5px #45325606, 0 7px 18px #45325606;
}
.chapter-node:hover { background: #e8e0f3; border-color: #cbbbdf; }
.chapter-node[aria-current] {
  background: #eee8f7;
  border-color: #ae94c7;
  box-shadow: 0 0 0 3px #a38bbb16, 0 6px 20px #4532560b;
}
.chapter-node .node-question { color: #59466e; font-size: 14px; line-height: 1.45; }
.chapter-label { color: #9b87b0; font-size: 10px; line-height: 1; font-weight: 500; }
.chapter-read { position: absolute; right: 12px; top: 11px; color: #9b87b0; font-size: 14px; }
.canvas-navigation {
  position: absolute;
  z-index: 3;
  bottom: 20px;
  left: 22px;
  gap: 1px;
  padding: 4px;
  border: 1px solid #e0d5ea;
  border-radius: 10px;
  background: #ffffffed;
  backdrop-filter: blur(14px);
  box-shadow: 0 2px 5px #322c3705, 0 5px 16px #322c3708;
}
.zoom-tools { gap: 1px; }
.canvas-navigation button { height: 28px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; }
.zoom-tools button { min-width: 26px; font-size: 16px; font-weight: 400; }
.zoom-tools .zoom-value { min-width: 46px; color: #62586a; font-variant-numeric: tabular-nums; font-size: 11px; }
.canvas-navigation .fit-tool { margin-left: 4px; padding-left: 12px; border-left: 1px solid #e6deee; border-radius: 0 5px 5px 0; font-size: 11px; }
.canvas-empty { display: grid; place-items: center; padding: 30px; color: var(--rove-muted, #82778e); font-size: 13px; }
.canvas-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1080px) {
  .canvas-bar { padding: 16px 18px 10px; }
  .canvas-navigation { left: 16px; bottom: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .canvas-node, .canvas-bar button, .canvas-navigation button { transition: none; }
}
</style>
