<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import SafeMarkdown from './SafeMarkdown.vue'
import NodeAnswerEditor from './NodeAnswerEditor.vue'
import { selectedAnswerText } from './selectedText'
import { answerText, type AnswerClip, type AnswerVersion, type Card, type CardQuestion } from './types'
import {
  appendChatAnswerRevision, approveChatAnswerSpan, getActiveAnswerRevision,
  getAnswerRevisions, getChatAnswerRevision, revokeChatAnswerSpan, selectChatAnswerRevision,
} from './chatVersions'

const props = defineProps<{ card: Card; depth?: number; pageCount?: number; selectedId?: string | null; standalone?: boolean; chat?: boolean; revisionId?: string }>()
const emit = defineEmits<{
  ask: [payload: CardQuestion]
  remove: [card: Card]
  source: [page: number]
  activate: [id: string]
  polish: [payload: { card: Card; instruction: string; revisionId: string }]
  'view-revision': [id: string]
}>()

const hasEdit = computed(() => props.card.editedAnswer !== undefined)
const autoTitle = computed(() => props.card.studyContext?.title?.trim() || '')
const version = ref<AnswerVersion>(hasEdit.value ? 'edited' : 'original')
const viewRevisionId = ref(getActiveAnswerRevision(props.card).id)
const answerRevisions = computed(() => getAnswerRevisions(props.card))
const currentRevision = computed(() => getChatAnswerRevision(props.card, viewRevisionId.value) ?? getActiveAnswerRevision(props.card))
const visibleAnswer = computed(() => props.chat ? currentRevision.value.text : answerText(props.card, version.value))
const busy = computed(() => !!props.card.loading || !!props.chat && !!props.card.chatBusy)
const leaf = computed(() => props.card.children.length === 0)
const answerElement = ref<HTMLElement>()
const editorElement = ref<HTMLTextAreaElement>()
const blockEditor = ref<InstanceType<typeof NodeAnswerEditor>>()
const editDialog = ref<HTMLDialogElement>()
const editAnchor = shallowRef<HTMLElement>()
const inputElement = ref<HTMLTextAreaElement>()
const editDraft = ref<string | null>(null)
const editing = ref(false)
const question = ref('')
const typing = ref(false)
const hasQuestionDraft = ref(false)
type ClipSelection = Pick<AnswerClip, 'text' | 'version' | 'answerRevisionId'>
const selection = shallowRef<ClipSelection | null>(null)
const quote = shallowRef<ClipSelection | null>(null)
const parentContext = ref('')
const parentRevisionId = ref<string>()
const parentAnswerVersion = ref<AnswerVersion>()
const editBaseRevisionId = ref<string>()
const hasDraft = computed(() => props.chat
  ? typeof props.card.answerDrafts?.[currentRevision.value.id] === 'string'
  : editDraft.value !== null)
const operationError = ref('')
const polishOpen = ref(false)
const polishInstruction = ref('')
const polishInput = ref<HTMLTextAreaElement>()
const reviewRange = ref<{ revisionId: string; start: number; end: number }>()
const reviewedSpans = computed(() => (currentRevision.value.approvals ?? []).filter(item =>
  item.start >= 0 && item.end > item.start && item.text === currentRevision.value.text.slice(item.start, item.end)))

watch(() => props.card.activeAnswerId, () => {
  if (!props.chat) return
  viewRevisionId.value = getActiveAnswerRevision(props.card).id
  emit('view-revision', viewRevisionId.value)
  selection.value = null
  reviewRange.value = undefined
  suspendChatEdit()
  polishOpen.value = false
  polishInstruction.value = ''
})
watch(() => props.revisionId, id => {
  if (!props.chat || busy.value || !id || id === viewRevisionId.value || !getChatAnswerRevision(props.card, id)) return
  viewRevisionId.value = id
  selection.value = null
  reviewRange.value = undefined
  suspendChatEdit()
  emit('view-revision', id)
}, { immediate: true })

function label(value: AnswerVersion) { return value === 'original' ? '原回答' : '修订版' }
function revisionLabel(id: string, index: number) {
  const item = getChatAnswerRevision(props.card, id)
  return 'v' + (index + 1) + ' · ' + (item?.kind === 'polish' ? 'AI 打磨' : item?.kind === 'edit' ? '手动修订' : '原回答')
}
function reportError(error: unknown) { operationError.value = error instanceof Error ? error.message : String(error) }
function activate() { emit('activate', props.card.id) }
function focusCard(event: FocusEvent) {
  if ((event.target as Element).closest('.question-card') === event.currentTarget) activate()
}
function switchVersion(next: AnswerVersion) {
  if (props.chat) { switchChatVersion(next); return }
  version.value = next
  selection.value = null
  editing.value = false  // Keep an unfinished draft when comparing versions.
}
function switchChatVersion(id: string) {
  if (busy.value) return
  try {
    if (!getChatAnswerRevision(props.card, id)) throw new Error('找不到所选回答版本。')
    if (leaf.value) selectChatAnswerRevision(props.card, id)
    viewRevisionId.value = id
    emit('view-revision', id)
    selection.value = null
    reviewRange.value = undefined
    suspendChatEdit()
    operationError.value = ''
  } catch (error) { reportError(error) }
}
// Bind an unpublished draft to its source revision. Only explicit save creates a revision.
let draftTimer: ReturnType<typeof setTimeout> | undefined
let dialogObserver: ResizeObserver | undefined
function dropStoredDraft(id: string) {
  const drafts = props.card.answerDrafts
  if (!drafts || !Object.hasOwn(drafts, id)) return
  delete drafts[id]
  if (!Object.keys(drafts).length) delete props.card.answerDrafts
}
function flushDraft() {
  clearTimeout(draftTimer)
  const id = editBaseRevisionId.value
  if (!props.chat || !id || editDraft.value === null) return
  const base = getChatAnswerRevision(props.card, id)
  if (!base) return
  if (base.text === editDraft.value) dropStoredDraft(id)
  else (props.card.answerDrafts ??= {})[id] = editDraft.value
}
function updateDraft(text: string) {
  if (busy.value || !leaf.value) return
  editDraft.value = text
  clearTimeout(draftTimer)
  draftTimer = setTimeout(flushDraft, 400)
}
function closeChatEditor() {
  clearTimeout(draftTimer)
  window.removeEventListener('pagehide', flushDraft)
  window.removeEventListener('resize', placeDialog)
  dialogObserver?.disconnect()
  dialogObserver = undefined
  const anchor = editAnchor.value
  if (anchor) editDialog.value?.close()
  editAnchor.value = undefined
  editing.value = false
  editDraft.value = null
  editBaseRevisionId.value = undefined
  if (anchor?.isConnected) anchor.focus({ preventScroll: true })
}
function suspendChatEdit() {
  if (!editing.value) return
  flushDraft()
  closeChatEditor()
}
onBeforeUnmount(() => {
  flushDraft()
  dialogObserver?.disconnect()
  window.removeEventListener('pagehide', flushDraft)
  window.removeEventListener('resize', placeDialog)
})
function placeDialog() {
  const dialog = editDialog.value, anchor = editAnchor.value
  if (!dialog || !anchor) return
  const bounds = anchor.getBoundingClientRect()
  const gap = 12
  const width = dialog.offsetWidth
  const preferred = bounds.right + gap + width <= window.innerWidth ? bounds.right + gap : bounds.left - gap - width
  dialog.style.left = Math.max(gap, Math.min(preferred, window.innerWidth - width - gap)) + 'px'
  dialog.style.top = Math.max(gap, Math.min(bounds.top, window.innerHeight - dialog.offsetHeight - gap)) + 'px'
}
async function editAnswer(anchor?: HTMLElement) {
  if (busy.value || props.chat && !leaf.value) return
  if (props.chat) {
    const id = currentRevision.value.id
    if (editBaseRevisionId.value !== id) editDraft.value = props.card.answerDrafts?.[id] ?? visibleAnswer.value
    editBaseRevisionId.value = id
    editAnchor.value = anchor
    window.addEventListener('pagehide', flushDraft)
    polishOpen.value = false
  }
  editDraft.value ??= visibleAnswer.value
  editing.value = true
  operationError.value = ''
  selection.value = null
  await nextTick()
  if (editAnchor.value && editDialog.value) {
    editDialog.value.showModal()
    placeDialog()
    dialogObserver = new ResizeObserver(placeDialog)
    dialogObserver.observe(editDialog.value)
    window.addEventListener('resize', placeDialog)
  }
  if (props.chat) blockEditor.value?.focus()
  else editorElement.value?.focus()
}
defineExpose({ editAnswer })
function saveEdit() {
  if (busy.value || editDraft.value === null || !editDraft.value.trim()) return
  if (props.chat) {
    try {
      if (!leaf.value || !editBaseRevisionId.value) return
      if (getChatAnswerRevision(props.card, editBaseRevisionId.value)?.text === editDraft.value) {
        cancelEdit()
        return
      }
      const saved = appendChatAnswerRevision(props.card, { text: editDraft.value, kind: 'edit', baseRevisionId: editBaseRevisionId.value })
      dropStoredDraft(editBaseRevisionId.value)
      viewRevisionId.value = saved.id
      closeChatEditor()
      selection.value = null
      operationError.value = ''
    } catch (error) { reportError(error) }
    return
  }
  props.card.editedAnswer = editDraft.value
  editDraft.value = null
  switchVersion('edited')
}
function cancelEdit() {
  if (props.chat) {
    if (editBaseRevisionId.value) dropStoredDraft(editBaseRevisionId.value)
    closeChatEditor()
    return
  }
  editing.value = false
  editDraft.value = null
  editBaseRevisionId.value = undefined
}

function rememberSelection() {
  if (busy.value) return
  const root = answerElement.value
  const current = window.getSelection()
  if (!root || !current || !current.rangeCount || current.isCollapsed) { selection.value = null; return }
  const range = current.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) { selection.value = null; return }
  const text = selectedAnswerText(root, range)
  selection.value = text ? props.chat
    ? { text, version: currentRevision.value.kind === 'edit' ? 'edited' : 'original', answerRevisionId: currentRevision.value.id }
    : { text, version: version.value } : null
}

function saveClip() {
  const pick = selection.value
  if (!pick || busy.value) return
  const clips: AnswerClip[] = props.card.clips ??= []
  if (!clips.some(clip => clip.version === pick.version && clip.answerRevisionId === pick.answerRevisionId && clip.text === pick.text)) {
    clips.push({ id: crypto.randomUUID(), ...pick })
  }
  selection.value = null
}
function removeClip(id: string) {
  if (busy.value) return
  if (props.card.clips) props.card.clips = props.card.clips.filter((clip: AnswerClip) => clip.id !== id)
}
async function beginQuestion(pick: ClipSelection | null = null) {
  if (busy.value) return
  if (!hasQuestionDraft.value || pick) {
    quote.value = pick ? { ...pick } : null
    if (props.chat) {
      const revisionId = pick ? pick.answerRevisionId ?? pick.version : currentRevision.value.id
      const revision = getChatAnswerRevision(props.card, revisionId)
      if (!revision) { operationError.value = '找不到摘录对应的回答版本。'; return }
      parentContext.value = revision.text
      parentRevisionId.value = revision.id
      parentAnswerVersion.value = revision.kind === 'edit' ? 'edited' : 'original'
    } else parentContext.value = answerText(props.card, pick?.version ?? version.value)
  }
  hasQuestionDraft.value = true
  typing.value = true
  await nextTick()
  inputElement.value?.focus()
}
function submit() {
  const text = question.value.trim()
  if (!text || busy.value) return
  emit('ask', {
    parent: props.card, question: text, excerpt: quote.value?.text ?? '',
    parentAnswer: parentContext.value, excerptVersion: quote.value?.version,
    ...(props.chat ? { parentAnswerRevisionId: parentRevisionId.value, parentAnswerVersion: parentAnswerVersion.value } : {})
  })
  question.value = ''
  quote.value = null
  parentContext.value = ''
  parentRevisionId.value = undefined
  parentAnswerVersion.value = undefined
  hasQuestionDraft.value = false
  typing.value = false
}
async function beginPolish() {
  if (busy.value || !leaf.value) return
  suspendChatEdit()
  polishOpen.value = true
  await nextTick()
  polishInput.value?.focus()
}
function submitPolish() {
  const instruction = polishInstruction.value.trim()
  if (busy.value || !leaf.value || !instruction || instruction.length > 2000) return
  operationError.value = ''
  emit('polish', { card: props.card, instruction, revisionId: currentRevision.value.id })
}
function captureReviewRange(event: Event) {
  const input = event.target as HTMLTextAreaElement
  const source = currentRevision.value.text
  if (input.value !== source.replace(/\r\n?/gu, '\n') || input.selectionStart >= input.selectionEnd) {
    reviewRange.value = undefined
    return
  }
  // Textarea selections count normalized line endings. Approvals refer to the exact stored source.
  function sourceOffset(offset: number) {
    let displayed = 0
    for (let index = 0; index <= source.length; index++) {
      if (displayed === offset) return index
      if (source[index] === '\r' && source[index + 1] === '\n') index++
      displayed++
    }
    return -1
  }
  reviewRange.value = { revisionId: currentRevision.value.id,
    start: sourceOffset(input.selectionStart), end: sourceOffset(input.selectionEnd) }
}
function approveSelectedRange() {
  const range = reviewRange.value
  if (!range || busy.value || range.revisionId !== currentRevision.value.id) return
  try {
    approveChatAnswerSpan(props.card, range.revisionId, range.start, range.end)
    reviewRange.value = undefined
    operationError.value = ''
  } catch (error) { reportError(error) }
}
function revokeApproval(id: string) {
  if (busy.value) return
  try { revokeChatAnswerSpan(props.card, currentRevision.value.id, id); operationError.value = '' }
  catch (error) { reportError(error) }
}
</script>

<template>
  <article :id="(standalone ? 'map-detail-' : 'question-') + card.id" tabindex="-1" class="question-card"
    :class="{ 'standalone-card': standalone, 'active-question': selectedId === card.id, 'deep-question': (depth || 0) >= 3 }"
    @pointerdown.stop="activate" @focusin.stop="focusCard" @mouseup.stop>
    <div class="card-heading">
      <button v-if="!standalone" type="button" class="fold" :title="card.collapsed ? '展开问题' : '收起问题'"
        :aria-label="card.collapsed ? '展开问题' : '收起问题'" :aria-expanded="!card.collapsed"
        @click="card.collapsed = !card.collapsed">{{ card.collapsed ? '▸' : '▾' }}</button>
      <strong><template v-if="autoTitle">{{ autoTitle }}</template><SafeMarkdown v-else inline :text="card.question" :page-count="pageCount" @source="emit('source', $event)" /></strong>
      <span v-if="!standalone && card.collapsed && card.children.length" class="branch-count">{{ card.children.length }} 个子问题</span>
      <button type="button" class="icon-btn delete-card" aria-label="删除问题及子问题" title="删除问题及子问题" :disabled="chat && busy" @click="(!chat || !busy) && emit('remove', card)">×</button>
    </div>
    <div v-show="standalone || !card.collapsed" class="card-content">
      <div v-if="autoTitle" class="original-question">
        <small>原始提问</small>
        <SafeMarkdown inline :text="card.question" :page-count="pageCount" @source="emit('source', $event)" />
      </div>
      <button v-if="card.page" class="source-link" @click="emit('source', card.page)">原文第 {{ card.page }} 页 ↗</button>
      <blockquote v-if="card.excerpt" class="card-quote">
        <small v-if="card.excerptVersion">引自上层{{ label(card.excerptVersion) }}</small>
        <SafeMarkdown inline class="quote-body" :text="card.excerpt" :page-count="pageCount" @source="emit('source', $event)" />
      </blockquote>
      <div v-if="card.loading" class="answer muted" role="status">正在组织回答…</div>
      <template v-else>
        <div class="answer-tools">
          <span class="answer-kind">{{ chat && currentRevision.kind === 'edit' ? '用户修订' : card.demo && (!chat || currentRevision.id === 'original') ? '演示回答' : 'AI 回答' }}</span>
          <label v-if="chat" class="chat-version-picker">
            <span class="chat-sr">回答版本</span>
            <select :value="currentRevision.id" aria-label="回答版本" :disabled="busy" @change="switchChatVersion(($event.target as HTMLSelectElement).value)">
              <option v-for="(item, index) in answerRevisions" :key="item.id" :value="item.id">{{ revisionLabel(item.id, index) }}</option>
            </select>
          </label>
          <div v-else-if="hasEdit" class="versions" aria-label="回答版本">
            <button type="button" :aria-pressed="version === 'original'" @click="switchVersion('original')">原回答</button>
            <button type="button" :aria-pressed="version === 'edited'" @click="switchVersion('edited')">修订版</button>
          </div>
          <button v-if="!editing && (!chat || leaf)" type="button" class="edit-link" :disabled="busy" @click="editAnswer()">{{ hasDraft ? '继续编辑' : '编辑回答' }}</button>
        </div>
        <p v-if="chat && !leaf" class="chat-frozen-note">此节点已展开，回答版本已固定</p>
        <p v-if="chat && card.chatBusy" class="chat-polish-status" role="status"><i aria-hidden="true"></i>正在打磨，完成后保存为新版本…</p>
        <p v-if="chat && (operationError || card.polishError)" class="chat-operation-error" role="alert">{{ operationError || card.polishError }}</p>
        <Teleport v-if="editing && chat" to="body" :disabled="!editAnchor">
          <component :is="editAnchor ? 'dialog' : 'div'" ref="editDialog" :class="{'map-edit-dialog':editAnchor}" aria-label="编辑节点回答"
            @cancel.prevent="suspendChatEdit">
            <header v-if="editAnchor" class="map-edit-heading">
              <strong>{{ autoTitle || card.question }}</strong>
              <button type="button" aria-label="收起编辑并保留草稿" title="收起编辑并保留草稿" @click="suspendChatEdit">×</button>
            </header>
            <div class="block-editor-scroll">
              <NodeAnswerEditor ref="blockEditor" :model-value="editDraft ?? ''" :disabled="busy || !leaf" @update:model-value="updateDraft" @save="saveEdit" />
            </div>
            <div class="edit-actions block-edit-actions">
              <span v-if="editAnchor && operationError" role="alert">{{ operationError }}</span>
              <button v-if="!editAnchor" type="button" @click="switchVersion('original')">查看原回答</button>
              <button type="button" @click="cancelEdit">取消编辑</button>
              <button type="button" class="primary" :disabled="!editDraft?.trim() || busy || !leaf" @click="saveEdit">保存修订</button>
            </div>
          </component>
        </Teleport>
        <div v-else-if="editing" class="answer-editor">
          <textarea ref="editorElement" v-model="editDraft" aria-label="修订回答" rows="6" :disabled="busy || chat && !leaf" @keydown.meta.enter.prevent="saveEdit" @keydown.ctrl.enter.prevent="saveEdit"></textarea>
          <div class="edit-actions">
            <button type="button" :disabled="busy" @click="switchVersion('original')">查看原回答</button>
            <button type="button" @click="cancelEdit">取消编辑</button>
            <button type="button" class="primary" :disabled="!editDraft?.trim() || busy || chat && !leaf" @click="saveEdit">保存修订</button>
          </div>
        </div>
        <div v-else ref="answerElement" class="answer" @pointerup="rememberSelection" @keyup="rememberSelection">
          <SafeMarkdown :text="visibleAnswer" :page-count="pageCount" @source="emit('source', $event)" />
        </div>
        <details v-if="chat && currentRevision.kind === 'polish' && currentRevision.request" class="chat-generation-input">
          <summary>本次打磨输入</summary>
          <p>{{ currentRevision.instruction }}</p>
          <pre>{{ currentRevision.request.context }}</pre>
        </details>
        <div v-if="selection" class="selection-actions">
          <button type="button" :disabled="busy" @click="beginQuestion(selection)">引用选段追问</button>
          <button type="button" :disabled="busy" @click="saveClip">摘录选段</button>
        </div>
        <ul v-if="card.clips?.length" class="clips" aria-label="已保存的摘录">
          <li v-for="clip in card.clips" :key="clip.id">
            <div class="clip-head"><small>{{ label(clip.version) }}摘录</small>
              <button type="button" :disabled="busy" @click="beginQuestion(clip)">引用追问</button>
              <button type="button" aria-label="删除摘录" class="remove-clip" :disabled="busy" @click="removeClip(clip.id)">×</button>
            </div>
            <SafeMarkdown inline class="quote-body" :text="clip.text" :page-count="pageCount" @source="emit('source', $event)" />
          </li>
        </ul>
        <details v-if="chat" class="chat-review">
          <summary>字符级审核<span>{{ reviewedSpans.length ? reviewedSpans.length + ' 段已审核' : '待审核' }}</span></summary>
          <div class="chat-review-body">
            <p>在 Markdown 原文中选取认可的字符，再点击审核选段。已审核片段会进入 Ground Truth Wiki。</p>
            <textarea :key="currentRevision.id" :value="visibleAnswer" readonly aria-label="字符级审核原文" rows="7"
              :disabled="busy" @select="captureReviewRange" @keyup="captureReviewRange" @pointerup="captureReviewRange"></textarea>
            <div class="chat-review-actions">
              <small>{{ reviewRange ? '已选取原文片段' : '请在原文中选择需要审核的范围' }}</small>
              <button type="button" :disabled="busy || !reviewRange" @click="approveSelectedRange">审核选段</button>
            </div>
            <ul v-if="reviewedSpans.length" class="chat-approved-spans" aria-label="已审核字符片段">
              <li v-for="item in reviewedSpans" :key="item.id">
                <div><span>已审核选段</span><button type="button" :disabled="busy" @click="revokeApproval(item.id)">撤回审核</button></div>
                <pre>{{ item.text }}</pre>
              </li>
            </ul>
          </div>
        </details>
        <div class="card-actions chat-node-actions">
          <button v-if="!typing" type="button" :disabled="busy" @click="beginQuestion()">＋ 继续追问</button>
          <button v-if="chat && leaf && !polishOpen" type="button" class="polish-trigger" :disabled="busy" @click="beginPolish">打磨回答</button>
        </div>
        <form v-if="chat && leaf && polishOpen" class="chat-polish-form" @submit.prevent="submitPolish">
          <label :for="'polish-' + card.id">这次希望怎样打磨？</label>
          <textarea :id="'polish-' + card.id" ref="polishInput" v-model="polishInstruction" :disabled="busy" required maxlength="2000" rows="3"
            aria-label="打磨要求" placeholder="例如，检查适用条件，补全推导或修正表述…" @keydown.meta.enter.prevent="submitPolish" @keydown.ctrl.enter.prevent="submitPolish"></textarea>
          <div class="edit-actions"><button type="button" :disabled="busy" @click="polishOpen=false">收起</button>
            <button type="submit" class="primary" :disabled="busy || !polishInstruction.trim()">{{ card.chatBusy ? '正在打磨…' : '生成打磨版本' }}</button></div>
        </form>
        <form v-if="typing" class="followup" @submit.prevent="submit">
          <blockquote v-if="quote" class="card-quote">
            <small>引用{{ label(quote.version) }}</small>
            <SafeMarkdown inline class="quote-body" :text="quote.text" :page-count="pageCount" @source="emit('source', $event)" />
          </blockquote>
          <textarea ref="inputElement" v-model="question" aria-label="追问内容" placeholder="继续这个话题，或探索另一个方向…" rows="2" :disabled="busy"
            @keydown.meta.enter.prevent="submit" @keydown.ctrl.enter.prevent="submit"></textarea>
          <div class="edit-actions"><button type="button" @click="typing=false">收起</button>
            <button type="submit" class="primary" :disabled="!question.trim() || busy">提问 ↗</button></div>
        </form>
      </template>
      <div v-if="!standalone && card.children.length" class="children">
        <QuestionCard v-for="child in card.children" :key="child.id" :card="child" :depth="(depth || 0) + 1"
          :page-count="pageCount" :selected-id="selectedId" :chat="chat" @activate="emit('activate',$event)"
          @source="emit('source',$event)" @ask="emit('ask',$event)" @remove="emit('remove',$event)" @polish="emit('polish',$event)" />
      </div>
    </div>
  </article>
</template>

<style scoped>
.question-card {
  min-width: 0;
  margin: 0 0 12px;
  border: 1px solid var(--rove-line);
  border-radius: 12px;
  background: var(--rove-surface);
  color: var(--rove-text);
  scroll-margin-block: 24px;
}
.question-card.active-question { border-color: var(--rove-accent); }
.question-card.standalone-card { margin: 0; border: 0; border-radius: 0; }
.question-card:focus-visible,
.question-card button:focus-visible,
.question-card textarea:focus-visible {
  outline: 2px solid var(--rove-accent);
  outline-offset: 3px;
}
.card-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 14px 16px;
  color: var(--rove-text);
  font-size: calc(14px * var(--rove-font-scale, 1));
  line-height: 1.5;
}
.card-heading strong { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.standalone-card > .card-heading { padding: 0 0 18px; font-size: calc(21px * var(--rove-font-scale, 1)); letter-spacing: -.025em; line-height: 1.45; }
.fold,.delete-card { flex: none; border: 0; background: transparent; color: var(--rove-secondary); cursor: pointer; }
.fold { padding: 0; font-size: calc(15px * var(--rove-font-scale, 1)); }
.delete-card { align-self: flex-start; margin-top: 1px; padding: 1px 5px; border-radius: 5px; font-size: calc(19px * var(--rove-font-scale, 1)); line-height: 1; }
.delete-card:hover { color: #a24e45; background: var(--rove-rail); }
.branch-count,.answer-kind,.clip-head small,.card-quote small { color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
.card-content { min-width: 0; padding: 0 16px 16px 28px; }
.standalone-card > .card-content { padding: 0; }
.original-question {
  margin: 0 0 23px;
  padding: 12px 14px;
  border: 1px solid var(--rove-line);
  border-radius: 10px;
  background: var(--rove-canvas);
  color: var(--rove-text);
  font-size: calc(13px * var(--rove-font-scale, 1));
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.original-question > small { display: block; margin-bottom: 5px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650); }
.card-quote,.clips li {
  margin: 12px 0;
  padding: 11px 13px;
  border: 0;
  border-left: 2px solid var(--rove-line);
  border-radius: 0 8px 8px 0;
  background: var(--rove-canvas);
}
.card-quote > small { display: block; margin-bottom: 5px; }
.quote-body { display: block; color: var(--rove-secondary); font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.answer { color: var(--rove-text); font-size: calc(14px * var(--rove-font-scale, 1)); line-height: 1.85; white-space: normal; overflow-wrap: anywhere; }
.answer.muted { padding: 12px 0; color: var(--rove-muted); }
.answer :deep(.katex),.answer :deep(.katex-html) { user-select: text; }
.answer-tools,.versions,.selection-actions,.edit-actions,.clip-head { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.answer-tools { margin: 0 0 14px; min-height: 24px; }
.answer-kind { font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650); letter-spacing: .01em; }
.answer-tools button,.edit-actions button,.selection-actions button,.clip-head button,.card-actions button {
  min-height: 28px;
  padding: 5px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--rove-accent);
  font: inherit;
  font-size: calc(11px * var(--rove-font-scale, 1));
  line-height: 1.4;
  cursor: pointer;
}
.answer-tools button:hover,.edit-actions button:hover,.clip-head button:hover { background: var(--rove-rail); }
.versions { padding: 2px; gap: 2px; border: 1px solid var(--rove-line); border-radius: 7px; background: var(--rove-rail); }
.versions button { min-height: 23px; padding: 3px 7px; color: var(--rove-accent-strong); font-size: calc(11px * var(--rove-font-scale, 1)); }
.versions button[aria-pressed=true] { color: var(--rove-text); background: var(--rove-surface); box-shadow: 0 1px 3px color-mix(in srgb, var(--rove-text) 8.6%, transparent); }
.edit-link { margin-left: auto; }
.map-edit-dialog {
  position: fixed; inset: auto; margin: 0; padding: 0; width: min(500px, calc(100vw - 24px));
  max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); box-sizing: border-box;
  color: var(--rove-text); background: var(--rove-surface); border: 1px solid var(--rove-line);
  border-radius: 14px; box-shadow: 0 12px 48px #21162d26; font: inherit;
}
.map-edit-dialog[open] { display: flex; flex-direction: column; }
.map-edit-dialog::backdrop { background: color-mix(in srgb, var(--rove-text) 9%, transparent); }
.map-edit-heading { display: flex; align-items: center; gap: 12px; padding: 12px 15px; border-bottom: 1px solid var(--rove-line); }
.map-edit-heading strong { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1rem; font-weight: 600; }
.map-edit-heading button { border: 0; background: transparent; color: var(--rove-secondary); font: inherit; font-size: 1.3rem; cursor: pointer; }
.map-edit-dialog .block-editor-scroll { padding: 14px; min-height: 0; overflow: auto; max-height: min(60dvh, 540px); }
.map-edit-dialog .block-edit-actions { margin: 0; padding: 10px 14px; border-top: 1px solid var(--rove-line); }
.block-edit-actions [role="alert"] { flex-basis: 100%; color: #a16b72; }
.answer-editor textarea,.followup textarea {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--rove-line);
  border-radius: 10px;
  padding: 12px;
  background: var(--rove-surface);
  color: var(--rove-text);
  font: inherit;
  font-size: calc(13px * var(--rove-font-scale, 1));
  line-height: 1.75;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--rove-text) 2%, transparent);
}
.answer-editor textarea:focus,.followup textarea:focus { border-color: var(--rove-accent); }
.followup textarea::placeholder { color: var(--rove-secondary); }
.edit-actions { justify-content: flex-end; margin-top: 9px; gap: 5px; }
.edit-actions .primary { padding-inline: 12px; background: var(--rove-accent-strong); color: #fff; box-shadow: 0 1px 2px color-mix(in srgb, var(--rove-text) 12.5%, transparent); }
.edit-actions .primary:hover { background: var(--rove-accent-strong); }
.edit-actions button:disabled,.selection-actions button:disabled { cursor: default; opacity: .45; }
.selection-actions { margin-top: 14px; }
.selection-actions button { background: var(--rove-rail); }
.selection-actions button:hover,.card-actions button:hover { background: var(--rove-accent-soft); }
.card-actions { display: flex; margin-top: 22px; }
.card-actions button { padding: 8px 12px; border: 1px solid var(--rove-line); border-radius: 8px; background: var(--rove-rail); font-size: calc(12px * var(--rove-font-scale, 1)); }
.followup { margin-top: 20px; }
.clips { list-style: none; padding: 0; margin: 16px 0; }
.clip-head { margin-bottom: 5px; }
.clip-head small { margin-right: auto; }
.clip-head .remove-clip { padding-inline: 4px; color: var(--rove-secondary); font-size: calc(16px * var(--rove-font-scale, 1)); }
.children { margin-top: 18px; }
.deep-question { border-width: 0 0 0 1px; border-radius: 0; }
.deep-question .card-content { padding-inline: 8px 0; }
.deep-question .card-heading { padding-inline: 8px 0; }
@media (prefers-reduced-motion: no-preference) {
  .question-card button { transition: background-color .14s, color .14s; }
}
</style>

<style scoped>
.chat-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.chat-version-picker { display: flex; min-width: 0; }
.chat-version-picker select {
  max-width: 100%;
  height: 27px;
  padding: 3px 7px;
  border: 1px solid var(--rove-line);
  border-radius: 6px;
  background: var(--rove-surface);
  color: var(--rove-secondary);
  font: inherit;
  font-size: calc(11px * var(--rove-font-scale, 1));
}
.chat-frozen-note { margin: -3px 0 17px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.6; }
.chat-operation-error { margin: 12px 0; color: #a16b72; font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.7; overflow-wrap: anywhere; }
.chat-polish-status { display: flex; align-items: center; gap: 8px; margin: 12px 0 17px; color: var(--rove-secondary); font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.6; }
.chat-polish-status i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--rove-accent-strong); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rove-text) 25.1%, transparent); }
.chat-node-actions { flex-wrap: wrap; align-items: center; gap: 8px; }
.chat-node-actions:empty { display: none; }
.chat-node-actions .polish-trigger { color: var(--rove-secondary); background: var(--rove-rail); border-color: var(--rove-line); }
.chat-node-actions .polish-trigger:hover { background: var(--rove-accent-soft); }
.chat-polish-form { margin-top: 18px; padding: 15px; border: 1px solid var(--rove-line); border-radius: 10px; background: var(--rove-surface); }
.chat-polish-form > label { display: block; margin-bottom: 9px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-polish-form textarea {
  display: block;
  width: 100%;
  min-width: 0;
  max-height: 220px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--rove-line);
  border-radius: 8px;
  background: var(--rove-surface);
  color: var(--rove-text);
  font: inherit;
  font-size: calc(12px * var(--rove-font-scale, 1));
  line-height: 1.75;
}
.chat-polish-form textarea::placeholder { color: var(--rove-muted); }
.chat-review { margin-top: 24px; border: 1px solid var(--rove-line); border-radius: 10px; background: var(--rove-surface); }
.chat-review > summary { padding: 11px 12px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); cursor: pointer; }
.chat-review > summary > span { float: right; margin-left: 8px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-review-body { padding: 0 12px 12px; }
.chat-review-body > p { margin: 0 0 10px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.75; }
.chat-review-body > textarea {
  display: block;
  width: 100%;
  min-width: 0;
  max-height: 360px;
  padding: 11px;
  resize: vertical;
  border: 1px solid var(--rove-line);
  border-radius: 7px;
  background: var(--rove-surface);
  color: var(--rove-secondary);
  font: calc(12px * var(--rove-font-scale, 1))/1.8 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
}
.chat-review-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.chat-review-actions small { color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-review-actions button { padding: 6px 10px; border: 1px solid var(--rove-line); border-radius: 6px; background: var(--rove-rail); color: var(--rove-accent-strong); font: inherit; font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-review-actions button:hover:enabled { background: var(--rove-accent-soft); }
.chat-approved-spans { margin: 14px 0 0; padding: 0; list-style: none; }
.chat-approved-spans li { margin-top: 8px; padding: 9px 10px; border-left: 2px solid var(--rove-line); border-radius: 0 5px 5px 0; background: var(--rove-rail); }
.chat-approved-spans li > div { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
.chat-approved-spans span { color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-approved-spans button { border: 0; padding: 2px 0; background: transparent; color: var(--rove-accent-strong); font: inherit; font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-approved-spans button:hover:enabled { color: var(--rove-accent-strong); }
.chat-approved-spans pre { max-height: 170px; margin: 7px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--rove-secondary); font-family: inherit; font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.7; }
</style>

<style scoped>
.chat-generation-input { margin-top: 18px; border-top: 1px solid var(--rove-line); padding-top: 12px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
.chat-generation-input summary { cursor: pointer; }
.chat-generation-input p { line-height: 1.7; }
.chat-generation-input pre { max-height: 240px; overflow: auto; padding: 10px; border-radius: 7px; background: var(--rove-canvas); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--rove-font-family); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.75; font-weight: var(--rove-font-weight, 450); }
</style>
