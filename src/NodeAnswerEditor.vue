<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import SafeMarkdown from './SafeMarkdown.vue'
import { editorBlockText, formatEditorSelection, splitEditorBlocks } from './nodeEditorBlocks'

const props = defineProps<{ modelValue: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: [] }>()

interface Block { id: number; body: string; tail: string }
type Mark = 'bold' | 'italic' | 'code'
const marks: { kind: Mark; label: string; glyph: string; shortcut: string }[] = [
  { kind: 'bold', label: '加粗', glyph: 'B', shortcut: '⌘B' },
  { kind: 'italic', label: '斜体', glyph: 'I', shortcut: '⌘I' },
  { kind: 'code', label: '行内代码', glyph: '‹›', shortcut: '' },
]
const commands = [
  { label: '正文', glyph: '¶', body: '', caret: 0 },
  { label: '标题', glyph: 'H₂', body: '## ', caret: 3 },
  { label: '无序列表', glyph: '•', body: '- ', caret: 2 },
  { label: '引用', glyph: '❝', body: '> ', caret: 2 },
  { label: '代码块', glyph: '{}', body: '```\n\n```', caret: 4 },
]
let sequence = 0
function loadBlocks(value: string): Block[] {
  return splitEditorBlocks(value).map(raw => ({ id: ++sequence, ...editorBlockText(raw) }))
}
const root = ref<HTMLElement>()
const blocks = ref(loadBlocks(props.modelValue))
const activeId = ref(blocks.value[0].id)
const active = computed(() => blocks.value.find(block => block.id === activeId.value))
const menu = ref<{ id: number; insert: boolean; index: number } | null>(null)
let composing = false
let lastPublished = props.modelValue
const display = (body: string) => body.replace(/\r\n?/g, '\n')
const area = () => root.value?.querySelector<HTMLTextAreaElement>('.node-editor__input')
const newline = () => props.modelValue.match(/\r\n|\r|\n/)?.[0] ?? '\n'
interface Cursor { start: number; end: number }
interface Snapshot extends Cursor { blocks: Block[]; activeId: number; size: number }
const undoStack: Snapshot[] = []
const redoStack: Snapshot[] = []
let pendingCursor: Cursor | null = null
let compositionCursor: Cursor | null = null
let lastInput: { block: number; type: string; end: number; time: number } | null = null
function selection(): Cursor {
  const field = area()
  return { start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0 }
}
function capture(cursor = selection()): Snapshot {
  const copies = blocks.value.map(block => ({ ...block }))
  return { ...cursor, activeId: activeId.value, blocks: copies, size: lastPublished.length + copies.length * 48 }
}
function pushHistory(stack: Snapshot[], snapshot: Snapshot) {
  stack.push(snapshot)
  let size = 0
  for (let i = stack.length - 1; i >= 0; i--) {
    size += stack[i].size
    if (stack.length - i > 50 || (i < stack.length - 1 && size > 4_000_000)) {
      stack.splice(0, i + 1)
      break
    }
  }
}
function checkpoint(cursor = selection()) {
  pushHistory(undoStack, capture(cursor))
  redoStack.length = 0
  lastInput = null
}
function restore(redo: boolean) {
  const previous = (redo ? redoStack : undoStack).pop()
  if (!previous) return
  pushHistory(redo ? undoStack : redoStack, capture())
  blocks.value = previous.blocks
  publish()
  void activate(previous.activeId, previous.start, previous.end)
}
function historyKey(event: KeyboardEvent) {
  if (props.disabled || composing || event.isComposing || event.keyCode === 229 || event.altKey) return
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
  event.preventDefault()
  event.stopPropagation()
  restore(event.shiftKey)
}
function beforeInput(event: InputEvent) {
  if (!composing && !props.disabled && ['historyUndo', 'historyRedo'].includes(event.inputType)) {
    event.preventDefault()
    restore(event.inputType === 'historyRedo')
  } else pendingCursor = selection()
}
function startComposition() {
  composing = true
  compositionCursor = selection()
  lastInput = null
}
function endComposition() {
  composing = false
  compositionCursor = null
}
function publish() {
  lastPublished = blocks.value.map(block => block.body + block.tail).join('')
  emit('update:modelValue', lastPublished)
}
watch(() => props.modelValue, value => {
  if (value === lastPublished) return
  lastPublished = value
  blocks.value = loadBlocks(value)
  activeId.value = blocks.value[0].id
  menu.value = null
  undoStack.length = redoStack.length = 0
  lastInput = pendingCursor = null
})
watch(() => props.disabled, disabled => { if (disabled) menu.value = null })
function focus() { area()?.focus() }
defineExpose({ focus })
async function activate(id: number, start?: number, end = start) {
  if (props.disabled) return
  lastInput = pendingCursor = null
  menu.value = null
  activeId.value = id
  await nextTick()
  if (activeId.value !== id) return
  const field = area()
  field?.focus()
  if (start !== undefined) field?.setSelectionRange(start, end ?? start)
}
function changeBody(block: Block, value: string) {
  // Textarea offsets refer to LF text. Preserve the original block's line ending on write.
  if (display(block.body) !== value) {
    const eol = block.body.match(/\r\n|\r|\n/)?.[0] ?? newline()
    block.body = eol === '\n' ? value : value.replace(/\n/g, eol)
  }
}
function onInput(block: Block, event: Event) {
  const field = event.target as HTMLTextAreaElement
  const value = field.value
  const previousCursor = pendingCursor ?? selection()
  pendingCursor = null
  if (value === display(block.body)) return
  if (composing) {
    if (compositionCursor) checkpoint(compositionCursor)
    compositionCursor = null
  } else {
    const type = (event as InputEvent).inputType
    const time = Date.now()
    const grouped = ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(type) &&
      lastInput?.block === block.id && lastInput.type === type && lastInput.end === previousCursor.start &&
      previousCursor.start === previousCursor.end && time - lastInput.time < 900
    if (!grouped) checkpoint(previousCursor)
    lastInput = { block: block.id, type, end: field.selectionEnd, time }
  }
  changeBody(block, value)
  publish()
  menu.value = value === '/' && !composing ? { id: block.id, insert: false, index: 0 } : null
}
function format(kind: Mark) {
  const field = area()
  const block = active.value
  if (!field || !block || props.disabled || composing) return
  const result = formatEditorSelection(field.value, field.selectionStart, field.selectionEnd, kind)
  checkpoint()
  changeBody(block, result.text)
  publish()
  void activate(block.id, result.start, result.end)
}
function insertAfter(block: Block, body: string) {
  const index = blocks.value.findIndex(item => item.id === block.id)
  const eol = newline()
  const inserted = { id: ++sequence, body, tail: index + 1 < blocks.value.length ? eol + eol : '' }
  // A paragraph break on either side prevents a new list/quote from absorbing the next block.
  if (!/\n[ \t]*\n$/.test(display(block.tail))) {
    block.tail += display(block.tail).endsWith('\n') ? eol : eol + eol
  }
  blocks.value.splice(index + 1, 0, inserted)
  return inserted
}
function choose(index: number) {
  const state = menu.value
  const command = commands[index]
  if (!state || !command || props.disabled) return
  const block = blocks.value.find(item => item.id === state.id)
  if (!block) return
  checkpoint()
  const target = state.insert ? insertAfter(block, '') : block
  changeBody(target, command.body)
  publish()
  void activate(target.id, command.caret)
}
async function openInsert(block: Block) {
  if (props.disabled) return
  if (menu.value?.insert && menu.value.id === block.id) { menu.value = null; return }
  menu.value = { id: block.id, insert: true, index: 0 }
  await nextTick()
  root.value?.querySelector<HTMLButtonElement>('.node-editor__option')?.focus()
}
// A textarea exposes logical newlines but not visual rows. For a wrapped line, compare
// the caret and the requested edge in a temporary element with the textarea's layout.
function onEdgeLine(field: HTMLTextAreaElement, up: boolean): boolean {
  const value = field.value
  const offset = field.selectionStart
  const segment = up ? value.slice(0, offset) : value.slice(offset)
  if (segment.includes('\n')) return false
  if (!segment || !field.clientWidth) return true
  const style = getComputedStyle(field)
  const mirror = document.createElement('div')
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0',
    boxSizing: 'border-box', width: field.clientWidth + 'px', padding: style.padding,
    font: style.font, whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    wordBreak: style.wordBreak, letterSpacing: style.letterSpacing, tabSize: style.tabSize,
    lineHeight: style.lineHeight, direction: style.direction,
  })
  const caret = document.createElement('span')
  const edge = document.createElement('span')
  caret.textContent = edge.textContent = '\u200B'
  if (up) mirror.append(edge)
  mirror.append(value.slice(0, offset), caret, value.slice(offset))
  if (!up) mirror.append(edge)
  document.body.append(mirror)
  const sameLine = Math.abs(caret.getBoundingClientRect().top - edge.getBoundingClientRect().top) < 1
  mirror.remove()
  return sameLine
}
function navigateBlock(block: Block, event: KeyboardEvent, field: HTMLTextAreaElement) {
  if (field.selectionStart !== field.selectionEnd) return
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  const neighbour = blocks.value[blocks.value.findIndex(item => item.id === block.id) + (backward ? -1 : 1)]
  if (!neighbour) return
  if (event.key === 'ArrowLeft' && field.selectionStart !== 0) return
  if (event.key === 'ArrowRight' && field.selectionEnd !== field.value.length) return
  if (['ArrowUp', 'ArrowDown'].includes(event.key) && !onEdgeLine(field, backward)) return
  event.preventDefault()
  event.stopPropagation()
  void activate(neighbour.id, backward ? display(neighbour.body).length : 0)
}
function menuKey(event: KeyboardEvent) {
  if (!menu.value || event.isComposing || composing) return false
  const state = menu.value
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopPropagation()
    state.index = (state.index + (event.key === 'ArrowUp' ? -1 : 1) + commands.length) % commands.length
    if (state.insert) root.value?.querySelectorAll<HTMLButtonElement>('.node-editor__option')[state.index]?.focus()
    return true
  }
  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
    event.preventDefault()
    event.stopPropagation()
    choose(state.index)
    return true
  }
  if (event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    menu.value = null
    if (state.insert) void nextTick(() => root.value?.querySelector<HTMLButtonElement>(`[data-plus="${state.id}"]`)?.focus())
    return true
  }
  return false
}
function onKey(block: Block, event: KeyboardEvent) {
  if (props.disabled || composing || event.isComposing || event.keyCode === 229) return
  if (menuKey(event)) return
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (mod && ['enter', 'b', 'i'].includes(key)) {
    event.preventDefault()
    event.stopPropagation()
    if (key === 'enter') emit('save')
    else format(key === 'b' ? 'bold' : 'italic')
    return
  }
  if (mod || event.altKey || event.shiftKey) return
  const field = event.target as HTMLTextAreaElement
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    navigateBlock(block, event, field)
    return
  }
  // Enter starts another simple paragraph; fenced code, lists and other structured blocks
  // retain native multiline editing. Shift+Enter always inserts an ordinary line break.
  if (key === 'enter' && !/[\r\n]/.test(block.body) && !/^\s*(?:[-*+>] |\d+[.)] |`{3}|~{3}|\$\$|\\\[|\|| {4})/.test(block.body)) {
    event.preventDefault()
    checkpoint()
    const remainder = field.value.slice(field.selectionEnd)
    const left = field.value.slice(0, field.selectionStart)
    changeBody(block, left)
    const inserted = insertAfter(block, remainder)
    publish()
    void activate(inserted.id, 0)
  } else if (key === 'backspace' && !block.body && blocks.value.length > 1) {
    const index = blocks.value.findIndex(item => item.id === block.id)
    event.preventDefault()
    checkpoint()
    const neighbour = blocks.value[index - 1] ?? blocks.value[1]
    if (index > 0 && index === blocks.value.length - 1) neighbour.tail = block.tail
    blocks.value.splice(index, 1)
    publish()
    void activate(neighbour.id, index > 0 ? display(neighbour.body).length : 0)
  }
}
function onBlur(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null)) menu.value = null
}
</script>

<template>
  <div ref="root" class="node-editor" @focusout="onBlur" @keydown.capture="historyKey">
    <div class="node-editor__bar" role="group" aria-label="文字格式">
      <span class="node-editor__bar-label">段落编辑</span>
      <button v-for="mark in marks" :key="mark.kind" type="button" class="node-editor__mark"
        :class="'mark-' + mark.kind" :aria-label="mark.label" :title="[mark.label, mark.shortcut].filter(Boolean).join(' · ')"
        :disabled="disabled" @mousedown.prevent @click="format(mark.kind)">{{ mark.glyph }}</button>
    </div>
    <div class="node-editor__sheet">
      <div v-for="(block, index) in blocks" :key="block.id" class="node-editor__row" :class="{ 'is-active': block.id === activeId }">
        <button class="node-editor__plus" :data-plus="block.id" type="button" aria-label="在此段后插入内容"
          title="在此段后插入内容" aria-haspopup="listbox" :aria-expanded="menu?.id === block.id && menu.insert"
          :disabled="disabled" @mousedown.prevent @click="openInsert(block)">+</button>
        <textarea v-if="activeId === block.id" :value="display(block.body)" class="node-editor__input" rows="1"
          aria-label="编辑当前段落" placeholder="输入正文，或输入 / 插入内容" :disabled="disabled" spellcheck="false"
          @beforeinput="beforeInput" @input="onInput(block, $event)" @keydown="onKey(block, $event)"
          @compositionstart="startComposition" @compositionend="endComposition" />
        <div v-else class="node-editor__preview" role="button" :tabindex="disabled ? -1 : 0" :aria-disabled="!!disabled"
          :aria-label="'编辑第 ' + (index + 1) + ' 段'" @click="activate(block.id)" @keydown.enter.prevent="activate(block.id)"
          @keydown.space.prevent="activate(block.id)">
          <SafeMarkdown v-if="block.body.trim()" :text="block.body" />
          <span v-else class="node-editor__empty">空段落</span>
        </div>
        <div v-if="menu?.id === block.id" role="listbox" aria-label="段落类型" class="node-editor__menu" @keydown="menuKey">
          <button v-for="(command, n) in commands" :key="command.label" class="node-editor__option" type="button" role="option"
            :aria-label="command.label" :aria-selected="menu.index === n" :tabindex="menu.insert && menu.index === n ? 0 : -1"
            :disabled="disabled" @mousedown.prevent @click="choose(n)">
            <span aria-hidden="true">{{ command.glyph }}</span>{{ command.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.node-editor { border: 1px solid var(--rove-line); border-radius: 10px; color: var(--rove-text); background: var(--rove-surface); min-width: 0; }
.node-editor__bar { display: flex; align-items: center; gap: 3px; padding: 5px 9px; border-bottom: 1px solid var(--rove-line); border-radius: 9px 9px 0 0; background: var(--rove-rail); }
.node-editor__bar-label { margin-right: 7px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.node-editor button { font: inherit; color: var(--rove-secondary); }
.node-editor button:disabled { opacity: .5; }
.node-editor__mark, .node-editor__plus { display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; }
.node-editor__mark { width: 30px; height: 29px; }
.node-editor .mark-bold { font-weight: 750; }
.node-editor .mark-italic { font-family: Georgia, serif; font-style: italic; }
.node-editor .mark-code { font: 600 17px/1 ui-monospace, monospace; }
.node-editor__mark:hover:enabled, .node-editor__plus:hover:enabled { background: var(--rove-accent-soft); color: var(--rove-accent-strong); }
.node-editor__sheet { padding: 10px 8px 10px 5px; }
.node-editor__row { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 0 3px; align-items: start; padding-block: 2px; }
.node-editor__plus { width: 22px; height: 24px; margin-top: 4px; line-height: 1; opacity: .3; }
.node-editor__row:focus-within .node-editor__plus, .node-editor__row:hover .node-editor__plus, .is-active .node-editor__plus { opacity: 1; }
.node-editor__preview, .node-editor__input { box-sizing: border-box; width: 100%; min-width: 0; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; font: inherit; font-size: calc(14px * var(--rove-font-scale, 1)); line-height: 1.8; }
.node-editor__input { field-sizing: content; min-height: 37px; max-height: 55vh; resize: none; color: var(--rove-text); background: color-mix(in srgb, var(--rove-accent-soft) 28%, var(--rove-surface)); border-color: var(--rove-line); }
.node-editor__input:focus-visible { outline: 1px solid var(--rove-accent); outline-offset: 0; }
.node-editor__preview { cursor: text; overflow-wrap: anywhere; }
.node-editor__preview:hover { background: var(--rove-rail); }
.node-editor__empty { color: var(--rove-muted); }
.node-editor__menu { grid-column: 2; z-index: 1; display: grid; margin: 4px 0 5px; width: min(100%, 195px); padding: 4px; border: 1px solid var(--rove-line); border-radius: 7px; background: var(--rove-surface); box-shadow: 0 4px 15px color-mix(in srgb, var(--rove-text) 8%, transparent); }
.node-editor__option { display: flex; align-items: center; gap: 9px; padding: 5px 9px; border: 0; border-radius: 4px; background: transparent; text-align: left; font-size: calc(12px * var(--rove-font-scale, 1)); }
.node-editor__option[aria-selected=true], .node-editor__option:hover { color: var(--rove-accent-strong); background: var(--rove-accent-soft); }
.node-editor__option span { display: inline-grid; place-items: center; width: 22px; height: 19px; color: var(--rove-secondary); font: 600 12px/1 ui-monospace, monospace; }
</style>
