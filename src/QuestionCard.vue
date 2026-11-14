<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from 'vue'
import SafeMarkdown from './SafeMarkdown.vue'
import { selectedAnswerText } from './selectedText'
import { answerText, type AnswerClip, type AnswerVersion, type Card, type CardQuestion } from './types'

const props = defineProps<{ card: Card; depth?: number; pageCount?: number; selectedId?: string | null; standalone?: boolean }>()
const emit = defineEmits<{
  ask: [payload: CardQuestion]
  remove: [card: Card]
  source: [page: number]
  activate: [id: string]
}>()

const hasEdit = computed(() => props.card.editedAnswer !== undefined)
const version = ref<AnswerVersion>(hasEdit.value ? 'edited' : 'original')
const visibleAnswer = computed(() => answerText(props.card, version.value))
const answerElement = ref<HTMLElement>()
const editorElement = ref<HTMLTextAreaElement>()
const inputElement = ref<HTMLTextAreaElement>()
const editDraft = ref<string | null>(null)
const editing = ref(false)
const question = ref('')
const typing = ref(false)
const hasQuestionDraft = ref(false)
const selection = shallowRef<Pick<AnswerClip, 'text' | 'version'> | null>(null)
const quote = shallowRef<Pick<AnswerClip, 'text' | 'version'> | null>(null)
const parentContext = ref('')

function label(value: AnswerVersion) { return value === 'original' ? '原回答' : '修订版' }
function activate() { emit('activate', props.card.id) }
function focusCard(event: FocusEvent) {
  if ((event.target as Element).closest('.question-card') === event.currentTarget) activate()
}
function switchVersion(next: AnswerVersion) {
  version.value = next
  selection.value = null
  editing.value = false  // Keep an unfinished draft when comparing versions.
}
async function editAnswer() {
  if (props.card.loading) return
  editDraft.value ??= visibleAnswer.value
  editing.value = true
  selection.value = null
  await nextTick()
  editorElement.value?.focus()
}
function saveEdit() {
  if (props.card.loading || editDraft.value === null || !editDraft.value.trim()) return
  props.card.editedAnswer = editDraft.value
  editDraft.value = null
  switchVersion('edited')
}
function cancelEdit() {
  editing.value = false
  editDraft.value = null
}

function rememberSelection() {
  const root = answerElement.value
  const current = window.getSelection()
  if (!root || !current || !current.rangeCount || current.isCollapsed) { selection.value = null; return }
  const range = current.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) { selection.value = null; return }
  const text = selectedAnswerText(root, range)
  selection.value = text ? { text, version: version.value } : null
}

function saveClip() {
  const pick = selection.value
  if (!pick) return
  const clips: AnswerClip[] = props.card.clips ??= []
  if (!clips.some(clip => clip.version === pick.version && clip.text === pick.text)) {
    clips.push({ id: crypto.randomUUID(), ...pick })
  }
  selection.value = null
}
function removeClip(id: string) {
  if (props.card.clips) props.card.clips = props.card.clips.filter((clip: AnswerClip) => clip.id !== id)
}
async function beginQuestion(pick: Pick<AnswerClip, 'text' | 'version'> | null = null) {
  if (props.card.loading) return
  if (!hasQuestionDraft.value || pick) {
    quote.value = pick ? { ...pick } : null
    parentContext.value = answerText(props.card, pick?.version ?? version.value)
  }
  hasQuestionDraft.value = true
  typing.value = true
  await nextTick()
  inputElement.value?.focus()
}
function submit() {
  const text = question.value.trim()
  if (!text || props.card.loading) return
  emit('ask', {
    parent: props.card, question: text, excerpt: quote.value?.text ?? '',
    parentAnswer: parentContext.value, excerptVersion: quote.value?.version
  })
  question.value = ''
  quote.value = null
  parentContext.value = ''
  hasQuestionDraft.value = false
  typing.value = false
}
</script>

<template>
  <article :id="(standalone ? 'map-detail-' : 'question-') + card.id" tabindex="-1" class="question-card"
    :class="{ 'active-question': selectedId === card.id, 'deep-question': (depth || 0) >= 3 }"
    @pointerdown.stop="activate" @focusin.stop="focusCard" @mouseup.stop>
    <div class="card-heading">
      <button v-if="!standalone" type="button" class="fold" :title="card.collapsed ? '展开问题' : '收起问题'"
        :aria-label="card.collapsed ? '展开问题' : '收起问题'" :aria-expanded="!card.collapsed"
        @click="card.collapsed = !card.collapsed">{{ card.collapsed ? '▸' : '▾' }}</button>
      <strong><SafeMarkdown inline :text="card.question" :page-count="pageCount" @source="emit('source', $event)" /></strong>
      <span v-if="!standalone && card.collapsed && card.children.length" class="branch-count">{{ card.children.length }} 个子问题</span>
      <button type="button" class="icon-btn delete-card" aria-label="删除问题及子问题" title="删除问题及子问题" @click="emit('remove', card)">×</button>
    </div>
    <div v-show="standalone || !card.collapsed" class="card-content">
      <button v-if="card.page" class="source-link" @click="emit('source', card.page)">原文第 {{ card.page }} 页 ↗</button>
      <blockquote v-if="card.excerpt" class="card-quote">
        <small v-if="card.excerptVersion">引自上层{{ label(card.excerptVersion) }}</small>
        <SafeMarkdown inline class="quote-body" :text="card.excerpt" :page-count="pageCount" @source="emit('source', $event)" />
      </blockquote>
      <div v-if="card.loading" class="answer muted" role="status">正在组织回答…</div>
      <template v-else>
        <div class="answer-tools">
          <span class="answer-kind">{{ card.demo ? '演示回答' : 'AI 回答' }}</span>
          <div v-if="hasEdit" class="versions" aria-label="回答版本">
            <button type="button" :aria-pressed="version === 'original'" @click="switchVersion('original')">原回答</button>
            <button type="button" :aria-pressed="version === 'edited'" @click="switchVersion('edited')">修订版</button>
          </div>
          <button v-if="!editing" type="button" class="edit-link" @click="editAnswer">{{ editDraft !== null ? '继续编辑' : '编辑回答' }}</button>
        </div>
        <div v-if="editing" class="answer-editor">
          <textarea ref="editorElement" v-model="editDraft" aria-label="修订回答" rows="6" @keydown.meta.enter.prevent="saveEdit" @keydown.ctrl.enter.prevent="saveEdit"></textarea>
          <div class="edit-actions">
            <button type="button" @click="switchVersion('original')">查看原回答</button>
            <button type="button" @click="cancelEdit">取消编辑</button>
            <button type="button" class="primary" :disabled="!editDraft?.trim()" @click="saveEdit">保存修订</button>
          </div>
        </div>
        <div v-else ref="answerElement" class="answer" @pointerup="rememberSelection" @keyup="rememberSelection">
          <SafeMarkdown :text="visibleAnswer" :page-count="pageCount" @source="emit('source', $event)" />
        </div>
        <div v-if="selection" class="selection-actions">
          <button type="button" @click="beginQuestion(selection)">引用选段追问</button>
          <button type="button" @click="saveClip">摘录选段</button>
        </div>
        <ul v-if="card.clips?.length" class="clips" aria-label="已保存的摘录">
          <li v-for="clip in card.clips" :key="clip.id">
            <div class="clip-head"><small>{{ label(clip.version) }}摘录</small>
              <button type="button" @click="beginQuestion(clip)">引用追问</button>
              <button type="button" aria-label="删除摘录" class="remove-clip" @click="removeClip(clip.id)">×</button>
            </div>
            <SafeMarkdown inline class="quote-body" :text="clip.text" :page-count="pageCount" @source="emit('source', $event)" />
          </li>
        </ul>
        <div v-if="!typing" class="card-actions"><button type="button" @click="beginQuestion()">＋ 继续追问</button></div>
        <form v-if="typing" class="followup" @submit.prevent="submit">
          <blockquote v-if="quote" class="card-quote">
            <small>引用{{ label(quote.version) }}</small>
            <SafeMarkdown inline class="quote-body" :text="quote.text" :page-count="pageCount" @source="emit('source', $event)" />
          </blockquote>
          <textarea ref="inputElement" v-model="question" aria-label="追问内容" placeholder="还有哪里不明白？" rows="2"
            @keydown.meta.enter.prevent="submit" @keydown.ctrl.enter.prevent="submit"></textarea>
          <div class="edit-actions"><button type="button" @click="typing=false">收起</button>
            <button type="submit" class="primary" :disabled="!question.trim()">提问 ↗</button></div>
        </form>
      </template>
      <div v-if="!standalone && card.children.length" class="children">
        <QuestionCard v-for="child in card.children" :key="child.id" :card="child" :depth="(depth || 0) + 1"
          :page-count="pageCount" :selected-id="selectedId" @activate="emit('activate',$event)"
          @source="emit('source',$event)" @ask="emit('ask',$event)" @remove="emit('remove',$event)" />
      </div>
    </div>
  </article>
</template>

<style scoped>
.question-card { min-width:0; border-color:#dce5db; background:#fcfdfb; scroll-margin-block:20px; }
.question-card.active-question { border-color:#87a08e; }
.question-card:focus-visible { outline:2px solid #6e947c; outline-offset:2px; }
.card-heading { align-items:baseline; gap:7px; padding:10px 12px; color:#304d3e; font-size:13px; }
.card-heading strong { min-width:0; overflow-wrap:anywhere; }
.branch-count,.answer-kind,.clip-head small,.card-quote small { color:#657568; font-size:10px; }
.card-content { padding:0 12px 12px 22px; }
.card-quote,.clips li { margin:8px 0; padding:7px 10px; border-left:2px solid #a7baaa; background:#f0f4ef; }
.card-quote > small { display:block; }
.quote-body { display:block; font-size:12px; line-height:1.55; color:#435748; white-space:pre-wrap; overflow-wrap:anywhere; }
.answer { white-space:normal; color:#34483b; font-size:13px; }
.answer :deep(.katex),.answer :deep(.katex-html) { user-select:text; }
.answer-tools,.versions,.selection-actions,.edit-actions,.clip-head { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.answer-tools { margin:3px 0 7px; }
.answer-tools button,.edit-actions button,.selection-actions button,.clip-head button,.card-actions button { padding:3px 7px; border:0; border-radius:4px; background:transparent; color:#41614b; font-size:11px; }
.answer-tools button:hover,.edit-actions button:hover,.clip-head button:hover { background:#eaf0e9; }
.versions { padding:2px; gap:2px; background:#edf0eb; border-radius:6px; }
.versions button[aria-pressed=true] { background:#fff; box-shadow:0 1px 2px #24312722; }
.edit-link { margin-left:auto; }
.answer-editor textarea,.followup textarea { display:block; width:100%; box-sizing:border-box; resize:vertical; border:1px solid #b9c8ba; border-radius:6px; padding:8px; color:#304639; background:#fff; font:inherit; font-size:13px; line-height:1.6; }
.edit-actions { justify-content:flex-end; margin-top:5px; }
.edit-actions .primary,.selection-actions button,.card-actions button { background:#e5eee4; color:#34533e; }
.selection-actions,.followup { margin-top:8px; }
.clips { list-style:none; padding:0; margin:8px 0; }
.clip-head small { margin-right:auto; }
.clip-head .remove-clip { font-size:15px; }
.children { margin-top:10px; }
.deep-question { border-width:0 0 0 1px; border-radius:0; }
.deep-question .card-content { padding-inline:4px 0; }
.deep-question .card-heading { padding-inline:4px 0; }
</style>
