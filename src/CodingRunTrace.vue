<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { CodeTraceRecord } from './codingTypes'

const props = defineProps<{ workspaceId: string; nodeId: string; running?: boolean }>()
const api = window.codingBridge
const pageSize = 100
const records = ref<CodeTraceRecord[]>([])
const cursor = ref(0)
const atEnd = ref(true)
const available = ref(false)
const partial = ref(false)
const loaded = ref(false)
const loading = ref(false)
const error = ref('')
const opened = reactive(new Set<number>())
const elements = new Map<number, HTMLDetailsElement>()
let generation = 0, disposed = false
let inFlight: number | undefined
let refreshQueued = false, manualQueued = false
let monitor: ReturnType<typeof setInterval> | undefined
let unsubscribe: (() => void) | undefined

const pairs = computed(() => {
  const calls = new Map<string, CodeTraceRecord>(), results = new Map<string, CodeTraceRecord>()
  for (const record of records.value) {
    const id = callId(record)
    if (!id) continue
    if (record.event.type === 'tool_call') calls.set(id, record)
    if (record.event.type === 'tool_result') results.set(id, record)
  }
  return { calls, results }
})
function typeOf(record: CodeTraceRecord) { return typeof record.event.type === 'string' ? record.event.type : 'event' }
function callId(record: CodeTraceRecord) { return typeof record.event.callId === 'string' ? record.event.callId : '' }
function counterpart(record: CodeTraceRecord) {
  const id = callId(record)
  return typeOf(record) === 'tool_call' ? pairs.value.results.get(id) : pairs.value.calls.get(id)
}
function toolName(record: CodeTraceRecord) {
  const call = typeOf(record) === 'tool_call' ? record : pairs.value.calls.get(callId(record))
  return typeof call?.event.tool === 'string' ? call.event.tool : ''
}
function title(record: CodeTraceRecord) {
  const type = typeOf(record)
  const labels: Record<string, string> = {
    session: '会话开始', status: '执行状态', text: '模型输出', thinking: '模型推理事件',
    tool_call: '工具调用', tool_result: '工具结果', error: '运行错误', final: '最终结果', diagnostic: '运行诊断',
    run_started: '开始运行', run_finished: '运行结束'
  }
  return labels[type] || (type.startsWith('rove') ? 'Rove 事件' : type)
}
function detailLabel(record: CodeTraceRecord) {
  if (typeOf(record) === 'tool_call' || typeOf(record) === 'tool_result') return toolName(record)
  if (typeof record.event.phase === 'string') return record.event.phase
  return ''
}
function outcome(record: CodeTraceRecord) {
  const event = typeOf(record) === 'tool_call' ? counterpart(record)?.event : record.event
  if (event?.status === 'error') return '失败'
  if (event?.status === 'completed') return '完成'
  if (typeof event?.status === 'string') return event.status
  if (event?.outcome === 'completed') return '完成'
  if (event?.outcome === 'failed') return '失败'
  if (event?.outcome === 'cancelled') return '已停止'
  return typeOf(record) === 'tool_call' ? '等待或尚未加载结果' : ''
}
function isError(record: CodeTraceRecord) { return typeOf(record) === 'error' || record.event.status === 'error' || record.event.outcome === 'failed' || counterpart(record)?.event.status === 'error' }
function timeLabel(at: unknown) {
  const date = new Date(typeof at === 'number' || typeof at === 'string' ? at : '')
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleTimeString('zh-CN', { hour12: false })
}
function format(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value) }
  catch { return String(value) }
}
function rememberElement(seq: number, value: unknown) {
  if (value) elements.set(seq, value as HTMLDetailsElement)
  else elements.delete(seq)
}
function toggle(record: CodeTraceRecord, event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) opened.add(record.seq)
  else opened.delete(record.seq)
}
async function openRecord(seq: number) {
  opened.add(seq)
  await nextTick()
  elements.get(seq)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

// The durable log is authoritative. Progress events wake this reader rather than
// appending a second copy, and an EOF cursor always resumes without skipping pages.
async function fetchPage(manual = false) {
  if (disposed || !props.workspaceId || !props.nodeId || (!manual && loaded.value && !atEnd.value)) return
  const token = generation
  if (inFlight === token) { refreshQueued = true; manualQueued ||= manual; return }
  const workspaceId = props.workspaceId, nodeId = props.nodeId
  inFlight = token
  loading.value = true
  try {
    const page = await api.trace({ workspaceId, nodeId, after: cursor.value, limit: pageSize })
    if (disposed || generation !== token) return
    const known = new Set(records.value.map(record => record.seq))
    const incoming = page.records.filter(record => {
      if (record.nodeId !== nodeId || known.has(record.seq)) return false
      known.add(record.seq)
      return true
    })
    records.value = [...records.value, ...incoming].sort((a, b) => a.seq - b.seq)
    cursor.value = Math.max(cursor.value, page.next)
    atEnd.value = page.done
    available.value = page.available
    partial.value ||= page.partial === true
    loaded.value = true
    error.value = ''
  } catch (reason) {
    if (!disposed && generation === token) {
      error.value = (reason instanceof Error ? reason.message : String(reason))
        .replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, '')
    }
  } finally {
    if (inFlight === token) inFlight = undefined
    if (!disposed && generation === token) {
      loading.value = false
      if (refreshQueued) {
        const manual = manualQueued
        refreshQueued = false; manualQueued = false
        void fetchPage(manual)
      }
    }
  }
}
function reset() {
  generation++
  records.value = []; cursor.value = 0; atEnd.value = true
  available.value = false; partial.value = false; loaded.value = false; error.value = ''
  refreshQueued = false; manualQueued = false; opened.clear(); elements.clear()
  void fetchPage(true)
}
watch(() => [props.workspaceId, props.nodeId], reset, { immediate: true })
watch(() => props.running, (running, previous) => {
  if (!running && previous && atEnd.value) void fetchPage()
})
onMounted(() => {
  unsubscribe = api.onProgress(progress => {
    if (progress.record?.nodeId === props.nodeId && atEnd.value) void fetchPage()
  })
  monitor = setInterval(() => { if (props.running && atEnd.value) void fetchPage() }, 1000)
})
onBeforeUnmount(() => {
  disposed = true; generation++
  if (monitor) clearInterval(monitor)
  unsubscribe?.()
})
</script>

<template>
  <div class="run-trace" aria-label="本轮运行记录">
    <div class="trace-heading">
      <div><b>运行记录</b><small>{{ running ? '正在记录' : '历史记录' }} · 已加载 {{ records.length }} 条</small></div>
      <button type="button" :disabled="loading" @click="fetchPage(true)">{{ loading ? '读取中…' : atEnd ? '刷新' : '加载更多' }}</button>
    </div>
    <p v-if="error" class="trace-error" role="alert">{{ error }}</p>
    <p v-if="partial" class="trace-warning" role="alert">本轮记录不完整，部分事件未能保存。</p>
    <div class="trace-scroll">
      <p v-if="!records.length" class="trace-empty">{{ loading && !loaded ? '正在读取运行记录…' : running ? '等待事件…' : !available ? '此节点尚无运行记录；旧版本未记录工具事件。' : '本轮尚无事件。' }}</p>
      <ol v-else class="trace-list">
        <li v-for="record in records" :key="record.seq">
          <details :ref="value => rememberElement(record.seq, value)" class="trace-entry" :class="{failed:isError(record)}" :open="opened.has(record.seq)" @toggle="toggle(record,$event)">
            <summary>
              <span class="trace-stamp"><code>#{{ record.seq }}</code><time :title="String(record.at)">{{ timeLabel(record.at) }}</time><small>{{ typeOf(record) }}</small></span>
              <span class="trace-title"><b>{{ title(record) }}</b><span>{{ detailLabel(record) }}</span><i v-if="outcome(record)">{{ outcome(record) }}</i></span>
              <code v-if="callId(record)" class="call-id">调用编号 {{ callId(record) }}</code>
              <small v-if="record.event.truncated === true" class="truncated">dsh 已截断此事件的部分内容</small>
            </summary>
            <div v-if="opened.has(record.seq)" class="trace-detail">
              <button v-if="counterpart(record)" type="button" class="pair-link" @click="openRecord(counterpart(record)!.seq)">{{ typeOf(record)==='tool_call' ? '查看结果' : '查看参数' }} #{{ counterpart(record)!.seq }}</button>
              <template v-if="typeOf(record)==='tool_call'"><h4>工具参数</h4><pre>{{ format(record.event.input) }}</pre></template>
              <template v-else-if="typeOf(record)==='tool_result'"><h4>工具结果</h4><pre>{{ format(record.event.result) }}</pre></template>
              <pre v-else>{{ format(record.event) }}</pre>
              <details class="complete-event"><summary>完整事件 JSON</summary><pre>{{ format(record) }}</pre></details>
            </div>
          </details>
        </li>
      </ol>
      <div class="trace-more">
        <button v-if="loaded && !atEnd" type="button" :disabled="loading" @click="fetchPage(true)">{{ loading ? '读取中…' : '加载更多 100 条' }}</button>
        <small v-else-if="records.length">{{ running ? '已跟上最新事件，继续接收中…' : '已到记录末尾' }}</small>
      </div>
    </div>
  </div>
</template>

<style scoped>
.run-trace { display:flex; flex:1; flex-direction:column; min-height:0; min-width:0; color:#304937; }
.trace-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px; border-bottom:1px solid #dce3d9; }
.trace-heading b,.trace-heading small { display:block; }
.trace-heading b { font-size:12px; }
.trace-heading small,.trace-more small { margin-top:4px; color:#708075; font-size:11px; }
.trace-heading button,.trace-more button,.pair-link { padding:4px 8px; border:1px solid #d1dbd0; border-radius:5px; background:#fff; color:#385441; font:11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
.trace-scroll { flex:1; min-height:0; overflow:auto; padding:10px; }
.trace-list { list-style:none; padding:0; margin:0; }
.trace-list>li { margin-bottom:8px; }
.trace-entry { border:1px solid #dde5d9; border-radius:7px; background:#fff; }
.trace-entry.failed { border-color:#d9b8a9; }
.trace-entry>summary { padding:8px 9px; cursor:pointer; list-style-position:inside; }
.trace-stamp,.trace-title { display:flex; flex-wrap:wrap; align-items:baseline; gap:5px 8px; min-width:0; }
.trace-stamp { color:#7b887e; font-size:10px; }
.trace-stamp code { color:#617667; }
.trace-stamp small { margin-left:auto; font:10px/1.4 ui-monospace,monospace; }
.trace-title { margin-top:4px; font-size:11px; }
.trace-title b { font-weight:600; }
.trace-title>span { overflow-wrap:anywhere; color:#586f5e; font-family:ui-monospace,monospace; }
.trace-title i { margin-left:auto; color:#6d7e70; font-size:10px; font-style:normal; }
.failed .trace-title { color:#8b4b34; }
.call-id { display:block; margin-top:5px; color:#7a887d; font-size:10px; overflow-wrap:anywhere; }
.truncated { display:block; margin-top:5px; color:#987237; font-size:10px; }
.trace-detail { padding:0 9px 9px; }
.trace-detail h4 { font-size:11px; margin:9px 0 5px; font-weight:500; }
.trace-detail pre { max-height:340px; margin:7px 0 0; padding:8px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:#f4f7f1; border-radius:4px; color:#3d5443; font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
.complete-event { margin-top:9px; }
.complete-event>summary { color:#64776a; font-size:10px; cursor:pointer; }
.trace-empty { color:#748277; font-size:12px; line-height:1.7; padding:2px 4px; }
.trace-error { margin:8px 12px 0; color:#8b4b34; font-size:11px; overflow-wrap:anywhere; }
.trace-warning { margin:8px 12px 0; color:#8d6c2d; font-size:11px; line-height:1.6; }
.trace-more { display:flex; justify-content:center; padding:9px 0; }
</style>
