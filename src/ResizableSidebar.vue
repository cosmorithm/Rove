<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = withDefaults(defineProps<{
  side: 'left' | 'right'
  storageKey: string
  initialWidth: number
  minWidth: number
  maxWidth?: number
  reservedWidth?: number
  label: string
}>(), { reservedWidth: 320 })

const root = ref<HTMLElement>()
const contentId = useId()
const preferred = ref(props.initialWidth)
const requested = computed(() => Math.max(0, props.minWidth, Math.min(preferred.value, props.maxWidth ?? Infinity)))
const available = ref(Infinity)
const maximum = computed(() => Math.max(0, Math.min(
  Math.max(props.minWidth, props.maxWidth ?? Infinity),
  available.value
)))
const minimum = computed(() => Math.max(0, Math.min(props.minWidth, maximum.value)))
function clamp(value: number) {
  return Math.round(Math.max(minimum.value, Math.min(maximum.value, value)))
}
const width = computed(() => clamp(preferred.value))
const dragging = ref(false)
let observer: ResizeObserver | undefined
let structure: MutationObserver | undefined
let drag: { id: number; x: number; width: number; moved: boolean; handle: HTMLElement; body: HTMLElement; cursor: string; select: string } | undefined

function readPreference() {
  preferred.value = props.initialWidth
  try {
    const saved = localStorage.getItem(props.storageKey)
    if (saved && Number.isFinite(Number(saved)) && Number(saved) > 0) preferred.value = Number(saved)
  } catch { /* Width changes still work for this session. */ }
}
function persist() {
  try { localStorage.setItem(props.storageKey, String(preferred.value)) } catch { /* Storage can be disabled. */ }
}
function measure() {
  const element = root.value
  const parent = element?.parentElement
  if (!element || !parent) return
  const style = getComputedStyle(parent)
  const px = (value: string) => parseFloat(value) || 0
  let space = parent.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
  const siblings = Array.from(parent.children).filter(sibling => sibling !== element && sibling.getClientRects().length)
  // A pair of sidebars shares the space left after reserving the main view.
  // Use requested sizes so a simultaneous parent resize cannot feed back on itself.
  space -= px(style.columnGap) * siblings.length
  const panels = siblings.filter(sibling => sibling.classList.contains('resizable-sidebar'))
  const reserve = Math.max(0, props.reservedWidth, ...panels.map(panel => Number(panel.getAttribute('data-reserve')) || 0))
  const fairShare = Math.max(0, space - reserve) / (1 + panels.length)
  for (const panel of panels) {
    space -= Math.min(Number(panel.getAttribute('data-requested')) || 0, fairShare)
  }
  available.value = Math.floor(Math.max(0, space - reserve))
}
function observeContainer() {
  const parent = root.value?.parentElement
  if (!parent || !observer) return
  observer.disconnect()
  observer.observe(parent)
  structure?.disconnect()
  structure?.observe(parent, { childList: true })
  for (const sibling of parent.children) {
    if (sibling.classList.contains('resizable-sidebar')) {
      structure?.observe(sibling, { attributes: true, attributeFilter: ['data-requested', 'data-reserve'] })
      if (sibling !== root.value) observer.observe(sibling)
    }
  }
  measure()
}
function endDrag() {
  if (!drag) return
  const { handle, body, cursor, select, id, moved } = drag
  drag = undefined
  dragging.value = false
  if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id)
  body.style.cursor = cursor
  body.style.userSelect = select
  if (moved) persist()
}
function startDrag(event: PointerEvent) {
  if (drag || !event.isPrimary || event.button !== 0) return
  const handle = event.currentTarget as HTMLElement
  const body = handle.ownerDocument.body
  measure()
  handle.setPointerCapture(event.pointerId)
  drag = { id: event.pointerId, x: event.clientX, width: width.value, moved: false,
    handle, body, cursor: body.style.cursor, select: body.style.userSelect }
  dragging.value = true
  body.style.cursor = 'col-resize'
  body.style.userSelect = 'none'
  handle.focus({ preventScroll: true })
  event.preventDefault()
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId || event.clientX === drag.x && !drag.moved) return
  const distance = (event.clientX - drag.x) * (props.side === 'left' ? 1 : -1)
  preferred.value = clamp(drag.width + distance)
  drag.moved = true
}
function finishPointer(event: PointerEvent) {
  if (event.pointerId === drag?.id) endDrag()
}
function resetWidth() {
  preferred.value = props.initialWidth
  persist()
}
function adjust(event: KeyboardEvent) {
  measure()
  let next: number
  switch (event.key) {
    case 'Home': next = minimum.value; break
    case 'End': next = maximum.value; break
    case 'ArrowLeft':
    case 'ArrowRight': {
      const direction = (event.key === 'ArrowRight') === (props.side === 'left') ? 1 : -1
      next = width.value + direction * (event.shiftKey ? 64 : 16)
      break
    }
    default: return
  }
  event.preventDefault()
  preferred.value = clamp(next)
  persist()
}

watch(() => props.storageKey, readPreference)
onMounted(() => {
  readPreference()
  observer = new ResizeObserver(measure)
  structure = new MutationObserver(records => {
    if (records.some(record => record.type === 'childList')) observeContainer()
    else measure()
  })
  observeContainer()
  window.addEventListener('blur', endDrag)
})
onBeforeUnmount(() => {
  endDrag()
  observer?.disconnect()
  structure?.disconnect()
  window.removeEventListener('blur', endDrag)
})
</script>

<template>
  <div ref="root" class="resizable-sidebar" :class="['sidebar-' + side, { 'is-resizing': dragging }]"
    :style="{ width: width + 'px' }" :data-requested="requested" :data-reserve="reservedWidth">
    <div :id="contentId" class="resizable-sidebar-content"><slot /></div>
    <div class="resize-handle" role="separator" tabindex="0" aria-orientation="vertical"
      :aria-controls="contentId" :aria-label="label" :aria-valuemin="minimum" :aria-valuemax="maximum"
      :aria-valuenow="width" :aria-valuetext="width + ' 像素'" :title="label + ' · 双击恢复默认宽度'"
      @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="finishPointer"
      @pointercancel="finishPointer" @lostpointercapture="finishPointer" @keydown="adjust" @dblclick="resetWidth" />
  </div>
</template>

<style scoped>
.resizable-sidebar { flex: none; display: flex; min-width: 0; min-height: 0; position: relative; box-sizing: border-box; }
.resizable-sidebar-content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.resize-handle { position: absolute; z-index: 5; top: 0; bottom: 0; width: 12px; padding: 0; cursor: col-resize; outline: none; touch-action: none; user-select: none; -webkit-app-region: no-drag; }
.sidebar-left > .resize-handle { right: -6px; }
.sidebar-right > .resize-handle { left: -6px; }
.resize-handle::after { content: ''; position: absolute; top: 0; bottom: 0; width: 2px; left: 5px; background: transparent; }
.resize-handle:hover::after,.resize-handle:focus-visible::after,.is-resizing > .resize-handle::after { background: #688e77; }
</style>
