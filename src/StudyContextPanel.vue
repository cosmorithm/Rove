<script setup lang="ts">
import { computed } from 'vue'
import type { StudyTurnMetadata, StudyTurnSource, StudyTurnVersion } from './studyContextTypes'
const props = defineProps<{ source: StudyTurnSource; metadata: StudyTurnMetadata | null; version?: StudyTurnVersion; busy: boolean; error: string }>()
const emit = defineEmits<{ retry: [] }>()
const levels = [{ level: 'L0', label: '标题' }, { level: 'L1', label: '短摘要' }, { level: 'L2', label: '详细摘要' }] as const
const cacheReady = computed(() => props.version?.state === 'ready' && levels.every(item => props.version?.summaries[item.level]?.text.trim()))
const status = computed(() => props.busy ? '正在生成标题与摘要' : props.error || props.version?.state === 'failed' ? '缓存生成失败'
  : cacheReady.value ? 'L0 / L1 / L2 已缓存' : props.version?.state === 'ready' ? '待补充 L0 标题' : '尚未生成缓存')
const request = computed(() => props.metadata?.request)
function date(value?: string) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN')
}
</script>

<template>
  <details class="study-turn-meta" aria-label="本轮对话元数据">
    <summary><b>对话元数据</b><span>{{ status }}</span></summary>
    <div class="metadata-body">
      <dl class="metadata-identifiers">
        <dt>节点</dt><dd>{{ source.nodeId }}</dd>
        <template v-if="source.parentId"><dt>父节点</dt><dd>{{ source.parentId }}</dd></template>
        <template v-if="version"><dt>原文版本</dt><dd :title="version.revision">{{ version.revision.slice(0, 16) }}</dd></template>
      </dl>
      <p v-if="error" class="cache-error" role="alert">{{ error }}</p>
      <button v-if="!cacheReady" type="button" class="cache-retry" :disabled="busy" @click="emit('retry')">{{ busy ? '生成中…' : error || version?.state === 'failed' ? '重试标题与摘要' : '生成 L0 / L1 / L2 缓存' }}</button>
      <div class="summary-caches">
        <details v-for="item in levels" :key="item.level">
          <summary>{{ item.level }} · {{ item.label }}<small>{{ version?.summaries[item.level] ? '已缓存' : '待生成' }}</small></summary>
          <template v-if="version?.summaries[item.level]">
            <p class="summary-text">{{ version.summaries[item.level]!.text }}</p>
            <small class="cache-date">{{ date(version.summaries[item.level]!.generatedAt) }}<span v-if="version.summaries[item.level]!.model"> · {{ version.summaries[item.level]!.model }}</span></small>
            <small v-if="version.summaries[item.level]!.inputTruncated" class="cache-warning">摘要输入已截断，原始问答仍保存在此版本元数据中。</small>
            <small v-if="version.summaries[item.level]!.outputTruncated" class="cache-warning">此级摘要已按长度上限截断。</small>
          </template>
        </details>
      </div>
      <details class="source-snapshot">
        <summary>原始问答快照 · {{ source.answerVersion === 'edited' ? '修订版' : '原回答' }}</summary>
        <h4>问题</h4><pre>{{ source.question }}</pre>
        <h4>回答</h4><pre>{{ source.answer }}</pre>
        <template v-if="source.excerpt"><h4>引用选段<span v-if="source.excerptVersion"> · {{ source.excerptVersion === 'edited' ? '修订版' : '原回答' }}</span></h4><pre>{{ source.excerpt }}</pre></template>
        <p class="source-name">{{ source.document.name }} · {{ source.document.title }}<span v-if="source.page"> · 第 {{ source.page }} 页</span></p>
      </details>
      <details v-if="request" class="context-snapshot">
        <summary>本轮实际上下文<span>{{ request.selection.depth }} 层 / {{ request.selection.level }}</span></summary>
        <p>{{ request.used.toLocaleString() }} / {{ request.limit.toLocaleString() }} 字 · {{ request.entries.length }} 个节点<span v-if="request.truncated" class="cache-warning"> · 已截断</span></p>
        <ol v-if="request.entries.length">
          <li v-for="entry in request.entries" :key="entry.nodeId"><code>{{ entry.nodeId }}</code><span>{{ entry.level }} · {{ entry.includedChars.toLocaleString() }} 字<span v-if="entry.truncated"> · 此处截断</span></span></li>
        </ol>
        <p v-if="request.omittedNodeIds.length" class="cache-warning">{{ request.omittedNodeIds.length }} 个更远节点未追加。</p>
        <details><summary>查看实际发送内容</summary><pre>{{ request.context }}</pre></details>
      </details>
      <p v-if="metadata?.versions.length && metadata.versions.length > 1" class="version-note">已保留 {{ metadata.versions.length }} 个原文版本，当前缓存对应上方版本。</p>
    </div>
  </details>
</template>

<style scoped>
.study-turn-meta { margin:16px 0 12px; border:1px solid #dce4d6; border-radius:7px; background:#fbfcf8; }
.study-turn-meta>summary { padding:9px 10px; cursor:pointer; color:#496345; font-size:11px; }
.study-turn-meta>summary b { font-weight:600; }
.study-turn-meta>summary>span { float:right; margin-left:8px; color:#7b8977; font-size:10px; }
.metadata-body { padding:0 10px 10px; font-size:11px; line-height:1.6; }
.metadata-identifiers { display:grid; grid-template-columns:auto 1fr; gap:3px 8px; margin:5px 0 10px; }
.metadata-identifiers dt { color:#7a8875; }
.metadata-identifiers dd { min-width:0; margin:0; color:#52654b; overflow-wrap:anywhere; font:10px/1.6 ui-monospace,monospace; }
.summary-caches>details,.source-snapshot,.context-snapshot { border-top:1px solid #e3e9dd; padding:7px 0; }
.metadata-body summary { cursor:pointer; color:#52694c; }
.summary-caches small,.context-snapshot>summary>span { margin-left:7px; color:#88937f; font-size:10px; }
.summary-text { margin:8px 0 5px; color:#40593b; white-space:pre-wrap; overflow-wrap:anywhere; }
.cache-date { display:block; margin:4px 0 0!important; }
.cache-error,.cache-warning { color:#96703c; overflow-wrap:anywhere; }
.cache-warning { display:block; margin:4px 0 0!important; font-size:10px; }
.cache-retry { padding:4px 8px; margin:1px 0 9px; border:1px solid #cfdbc6; border-radius:5px; background:#fff; color:#49673f; font:11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; cursor:pointer; }
.cache-retry:disabled { cursor:default; opacity:.6; }
.metadata-body h4 { font-size:10px; font-weight:500; color:#7d8c74; margin:8px 0 3px; }
.metadata-body pre { margin:5px 0; padding:7px; max-height:240px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:#f1f5ed; border-radius:4px; color:#42593d; font:10px/1.6 -apple-system,BlinkMacSystemFont,sans-serif; }
.source-name,.version-note { margin:7px 0 2px; color:#87937e; font-size:10px; }
.context-snapshot ol { padding-left:17px; }
.context-snapshot li { margin:5px 0; }
.context-snapshot li code { display:block; font:10px/1.5 ui-monospace,monospace; overflow-wrap:anywhere; }
.context-snapshot li>span { color:#7d8c74; font-size:10px; }
</style>
