<script setup lang="ts">
import { computed } from 'vue'
import type { PreparedStudyContext, StudyTurnMetadata, StudyTurnSource, StudyTurnVersion } from './studyContextTypes'
const props = defineProps<{ source: StudyTurnSource; metadata: StudyTurnMetadata | null; requestOverride?: PreparedStudyContext; version?: StudyTurnVersion; busy: boolean; error: string }>()
const emit = defineEmits<{ retry: [] }>()
const levels = [{ level: 'L0', label: '标题' }, { level: 'L1', label: '短摘要' }, { level: 'L2', label: '详细摘要' }] as const
const cacheReady = computed(() => props.version?.state === 'ready' && levels.every(item => props.version?.summaries[item.level]?.text.trim()))
const status = computed(() => props.busy ? '正在生成标题与摘要' : props.error || props.version?.state === 'failed' ? '缓存生成失败'
  : cacheReady.value ? 'L0 / L1 / L2 已缓存' : props.version?.state === 'ready' ? '待补充 L0 标题' : '尚未生成缓存')
const request = computed(() => props.requestOverride ?? props.metadata?.request)
function date(value?: string) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN')
}
</script>

<template>
  <details class="study-turn-meta" :class="{ 'cache-ready': cacheReady, 'cache-failed': !!error || version?.state === 'failed' }" aria-label="本轮对话元数据">
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
.study-turn-meta {
  margin: 25px 0 12px;
  border: 1px solid var(--rove-line);
  border-radius: 10px;
  background: var(--rove-surface);
  color: var(--rove-text);
}
.study-turn-meta > summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 8px;
  padding: 12px 13px;
  list-style: none;
  cursor: pointer;
  font-size: calc(11px * var(--rove-font-scale, 1));
  line-height: 1.5;
}
.study-turn-meta > summary::-webkit-details-marker { display: none; }
.study-turn-meta > summary::before {
  content: '';
  flex: none;
  width: 5px;
  height: 5px;
  margin-right: 2px;
  border: solid var(--rove-line);
  border-width: 1.5px 1.5px 0 0;
  transform: rotate(45deg);
}
.study-turn-meta[open] > summary::before { transform: rotate(135deg) translate(-1px, -1px); }
.study-turn-meta > summary b { color: var(--rove-secondary); font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650); }
.study-turn-meta > summary > span { margin-left: auto; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
.cache-ready > summary > span { color: var(--rove-accent); }
.cache-failed > summary > span { color: #a16e42; }
.study-turn-meta summary:focus-visible,.cache-retry:focus-visible { outline: 2px solid var(--rove-accent); outline-offset: 3px; border-radius: 5px; }
.metadata-body { min-width: 0; padding: 0 13px 9px; font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.7; }
.metadata-identifiers { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 5px 0 15px; }
.metadata-identifiers dt { color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
.metadata-identifiers dd { min-width: 0; margin: 0; color: var(--rove-secondary); overflow-wrap: anywhere; font: calc(11px * var(--rove-font-scale, 1))/1.7 ui-monospace, monospace; }
.summary-caches > details,.source-snapshot,.context-snapshot { border-top: 1px solid var(--rove-line); padding: 11px 0; }
.metadata-body summary { color: var(--rove-secondary); cursor: pointer; font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.7; }
.summary-caches > details > summary { display: list-item; }
.summary-caches small,.context-snapshot > summary > span { margin-left: 7px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.summary-text { margin: 12px 0 7px; color: var(--rove-text); font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.cache-date { display: block; margin: 6px 0 0 !important; overflow-wrap: anywhere; font-size: calc(11px * var(--rove-font-scale, 1)); }
.cache-error,.cache-warning { color: #a16e42; overflow-wrap: anywhere; }
.cache-error { padding: 9px 11px; border: 1px solid #efdfca; border-radius: 7px; background: #fcf7ef; font-size: calc(11px * var(--rove-font-scale, 1)); }
.cache-warning { display: block; margin: 5px 0 0 !important; font-size: calc(11px * var(--rove-font-scale, 1)); }
.cache-retry { min-height: 29px; margin: 0 0 13px; padding: 5px 9px; border: 1px solid var(--rove-line); border-radius: 6px; background: var(--rove-surface); color: var(--rove-accent); font: inherit; font-size: calc(11px * var(--rove-font-scale, 1)); cursor: pointer; }
.cache-retry:hover { background: var(--rove-rail); }
.cache-retry:disabled { cursor: default; opacity: .5; }
.metadata-body h4 { margin: 13px 0 5px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650); }
.metadata-body pre { max-height: 240px; margin: 6px 0; padding: 10px; overflow: auto; border: 1px solid var(--rove-line); border-radius: 7px; background: var(--rove-rail); color: var(--rove-text); font-family: var(--rove-font-family); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.75; font-weight: var(--rove-font-weight, 450); white-space: pre-wrap; overflow-wrap: anywhere; }
.source-name,.version-note { margin: 9px 0 2px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); overflow-wrap: anywhere; }
.context-snapshot ol { padding-left: 17px; }
.context-snapshot li { margin: 9px 0; }
.context-snapshot li code { display: block; color: var(--rove-secondary); font: calc(11px * var(--rove-font-scale, 1))/1.7 ui-monospace, monospace; overflow-wrap: anywhere; }
.context-snapshot li > span { color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); }
</style>
