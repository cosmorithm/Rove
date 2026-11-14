<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { Block } from './library'
import type { Card } from './types'
import SafeMarkdown from './SafeMarkdown.vue'

const props = defineProps<{ blocks: Block[]; selectedId?: string; selectedBlockId?: string; documentName: string }>()
const emit = defineEmits<{ select: [id: string]; read: [blockId: string]; start: [blockId?: string] }>()
const scroller = ref<HTMLElement>()
const scale = ref(1)
const focused = ref('')
const nodeButtons = new Map<string, HTMLButtonElement>()
const cardWidth = 226, cardHeight = 108, chapterWidth = 180, chapterHeight = 88
const columnGap = 48, rowGap = 26, margin = 30

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
  if (view) void zoom(Math.min(1, view.clientWidth / graph.value.width, view.clientHeight / graph.value.height), false)
}
function revealSelection() {
  if (revealKey.value) void focusNode(revealKey.value)
}
onMounted(revealSelection)
watch(revealKey, revealSelection)
watch(() => props.documentName, async () => { focused.value = ''; await zoom(1, false); revealSelection() })
</script>

<template>
  <section class="conversation-canvas" :aria-label="documentName + ' · 对话地图'">
    <header class="canvas-bar">
      <div class="canvas-location"><h2>对话地图</h2></div>
      <div class="canvas-tools">
        <slot name="actions" />
        <div v-if="graph.nodes.length" class="zoom-tools" aria-label="地图缩放">
          <button type="button" aria-label="缩小" title="缩小" :disabled="scale <= .12" @click="zoom(Math.max(.12, scale / 1.2))">−</button>
          <button type="button" class="zoom-value" aria-label="恢复原始大小" title="恢复原始大小" @click="zoom(1)">{{ Math.round(scale * 100) }}%</button>
          <button type="button" aria-label="放大" title="放大" :disabled="scale >= 1.8" @click="zoom(scale * 1.2)">+</button>
        </div>
        <button v-if="graph.nodes.length" type="button" class="fit-tool" title="让整张地图适应视图" @click="fit">适应视图</button>
        <button type="button" class="new-question" @click="emit('start')">新提问</button>
      </div>
    </header>
    <div v-if="!graph.nodes.length" class="canvas-empty">
      <p>暂无知识点</p>
    </div>
    <div v-else ref="scroller" class="canvas-scroll">
      <div class="canvas-extent" :style="{ width: graph.width * scale + 'px', height: graph.height * scale + 'px' }">
        <div class="canvas-plane" :style="{width:graph.width+'px',height:graph.height+'px',transform:'scale('+scale+')'}">
          <svg class="canvas-edges" :width="graph.width" :height="graph.height" aria-hidden="true">
            <path v-for="edge in graph.links" :key="edge.key" :d="edge.path" :class="{ current: selectedId === edge.child }" />
          </svg>
          <button v-for="node in graph.nodes" :key="node.key" :ref="el=>preserveButton(node.key,el)"
            type="button" class="canvas-node" :class="node.card ? 'exchange-node' : 'chapter-node'"
            :data-node="node.key" :data-map-id="node.card?.id" :data-block-id="!node.card ? node.block.id : undefined" :aria-current="node.key === currentKey ? 'location' : undefined"
            :tabindex="tabStop === node.key ? 0 : -1"
            :style="{left:node.x+'px',top:node.y+'px',width:node.width+'px',height:node.height+'px'}"
            @focus="focused=node.key" @keydown="navigate($event,node)"
            @click="node.card ? emit('select',node.card.id) : emit('read',node.block.id)">
            <template v-if="node.card">
              <span class="node-question"><SafeMarkdown inline :text="summary(node.card.question) || '未命名提问'" /></span>
              <span class="node-answer"><SafeMarkdown inline :text="node.card.loading ? '正在回答…' : summary(node.card.editedAnswer ?? node.card.answer) || '暂无回答'" /></span>
            </template>
            <template v-else>
              <span class="chapter-label">知识点</span>
              <span class="node-question"><SafeMarkdown inline :text="chapterTitle(node.block)" /></span>
              <span class="chapter-read" aria-hidden="true">↗</span><span class="canvas-sr">阅读此节</span>
            </template>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.conversation-canvas { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; color:#233a30; background:#f6f7f3; }
.canvas-bar { position:relative; z-index:2; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 14px; padding:13px 18px; border-bottom:1px solid #dce3da; background:#fbfcf9; }
.canvas-location,.canvas-tools,.zoom-tools { display:flex; align-items:center; }
.canvas-location { min-width:0; gap:12px; flex:1; }
.canvas-location h2 { flex:none; margin:0; color:#263e30; font:600 15px/1.3 -apple-system,BlinkMacSystemFont,sans-serif; }
.canvas-tools { gap:7px; }
.canvas-bar button { border:1px solid #d4dcd4; border-radius:6px; background:#fff; color:#3f5346; font:500 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; cursor:pointer; }
.canvas-bar button:hover { background:#edf2ec; }
.canvas-bar button:disabled { opacity:.4; cursor:default; }
.zoom-tools { background:white; border:1px solid #d4dcd4; border-radius:6px; overflow:hidden; }
.zoom-tools button { border:0; border-radius:0; min-width:26px; height:26px; padding:0 6px; }
.zoom-tools .zoom-value { min-width:40px; font-variant-numeric:tabular-nums; font-size:11px; }
.fit-tool,.new-question { padding:4px 9px; min-height:28px; }
.canvas-bar .new-question { background:#e5eee4; color:#335640; border-color:#bfcfc0; }
.canvas-scroll,.canvas-empty { overflow:auto; flex:1; min-height:0; min-width:0; overscroll-behavior:contain; background-image:radial-gradient(#97a59755 .8px,transparent .9px); background-size:16px 16px; }
.canvas-scroll { display:flex; }
.canvas-extent { flex:none; margin:auto; position:relative; overflow:hidden; }
.canvas-plane { position:absolute; top:0; left:0; transform-origin:0 0; }
.canvas-edges { position:absolute; inset:0; overflow:visible; pointer-events:none; fill:none; stroke:#a6b6a8; stroke-width:1.55; }
.canvas-edges .current { stroke:#64886d; stroke-width:2.2; }
.canvas-node { position:absolute; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center; gap:7px; min-width:0; padding:12px 14px; text-align:left; color:#2c4133; border:1px solid #d1dbd1; background:#fff; border-radius:10px; box-shadow:0 2px 5px #3145370c; cursor:pointer; }
.canvas-node:hover { border-color:#97af9d; box-shadow:0 2px 8px #31453718; }
.canvas-node[aria-current] { background:#f2f8f0; border-color:#769b7d; box-shadow:0 0 0 2px #d3e3d1; }
.canvas-node:focus-visible,.canvas-bar button:focus-visible { outline:2px solid #4f7a5c; outline-offset:-2px; }
.node-question,.node-answer { display:-webkit-box; overflow:hidden; overflow-wrap:anywhere; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-height:1.43; }
.node-question { font-size:13px; font-weight:600; color:#263b2d; }
.node-answer { color:#5b695e; font-size:12px; font-weight:400; }
.chapter-node { background:#e9efe5; border-color:#c4d1bf; border-radius:9px; padding-right:22px; }
.chapter-label { font-size:10px; color:#526b56; }
.chapter-read { position:absolute; right:8px; top:6px; color:#57735b; font-size:14px; }
.canvas-empty { display:grid; place-items:center; padding:30px; color:#647568; font-size:13px; }
.canvas-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
</style>
