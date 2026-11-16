<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { aiProviders, type AIConfigDraft, type AIConfigPublic, type AIProviderId } from './aiSettingsTypes'

const props = defineProps<{ config: AIConfigPublic }>()
const emit = defineEmits<{ close: []; saved: [config: AIConfigPublic] }>()

const dialog = ref<HTMLElement>()
const providerInput = ref<HTMLSelectElement>()
const savedConfig = ref(props.config)
const initialProvider = aiProviders.find(item => item.id === props.config.provider) ?? aiProviders[0]
const form = reactive({ provider: props.config.provider, baseUrl: props.config.baseUrl || initialProvider.baseUrl,
  model: props.config.model || initialProvider.defaultModel, apiKey: '', clearApiKey: false })
const provider = computed(() => aiProviders.find(item => item.id === form.provider) ?? aiProviders[0])
const loading = ref(true)
const operation = ref<'models' | 'test' | 'save' | ''>('')
const busy = computed(() => loading.value || operation.value !== '')
const advanced = ref(form.provider === 'custom')
const showKey = ref(false)
const discoveredModels = ref<string[]>([])
const models = computed(() => [...new Set([...provider.value.models, ...discoveredModels.value])])
const error = ref('')
const status = ref('')
const tested = ref(false)
let operationId = 0
let disposed = false
let previousFocus: HTMLElement | null = null

function normalizedBase(value: string) {
  try { return new URL(value.trim()).href.replace(/\/+$/, '') }
  catch { return value.trim().replace(/\/+$/, '') }
}
const canKeepKey = computed(() => savedConfig.value.hasApiKey && form.provider === savedConfig.value.provider &&
  normalizedBase(form.baseUrl) === normalizedBase(savedConfig.value.baseUrl))
const needsKey = computed(() => provider.value.requiresKey && !form.apiKey.trim() &&
  !(canKeepKey.value && !form.clearApiKey))
const canSave = computed(() => !busy.value && !!form.baseUrl.trim() && !!form.model.trim())

function clearFeedback() {
  operationId++
  operation.value = ''
  error.value = ''
  status.value = ''
  tested.value = false
}
function changeProvider(event: Event) {
  const id = (event.target as HTMLSelectElement).value as AIProviderId
  const selected = aiProviders.find(item => item.id === id)
  if (!selected) return
  clearFeedback()
  form.provider = selected.id
  form.baseUrl = selected.baseUrl
  form.model = selected.defaultModel
  form.apiKey = ''
  form.clearApiKey = false
  discoveredModels.value = []
  showKey.value = false
  advanced.value = selected.id === 'custom'
}
function changeEndpoint(event: Event) {
  clearFeedback()
  form.baseUrl = (event.target as HTMLInputElement).value
  form.apiKey = ''
  form.clearApiKey = false
  discoveredModels.value = []
  showKey.value = false
}
function draft(): AIConfigDraft {
  return { provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    ...(form.clearApiKey ? { clearApiKey: true } : {}) }
}
function message(reason: unknown) {
  const value = reason instanceof Error ? reason.message : '请求失败，请稍后重试。'
  const clean = value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  return form.apiKey ? clean.replaceAll(form.apiKey, '[密钥已省略]') : clean
}
async function run(kind: 'models' | 'test' | 'save') {
  if (busy.value) return
  if (kind !== 'save' && needsKey.value) { error.value = '请填写此服务商的 API Key。'; return }
  if (!form.baseUrl.trim()) { error.value = '请填写 API 地址。'; return }
  if (kind !== 'models' && !form.model.trim()) { error.value = '请选择或填写模型名称。'; return }
  clearFeedback()
  const id = ++operationId
  operation.value = kind
  try {
    const input = draft()
    if (kind === 'models') {
      const result = await window.studyBridge.listAIModels(input)
      if (disposed || id !== operationId) return
      discoveredModels.value = result
      status.value = result.length ? '已获取 ' + result.length + ' 个模型，可在模型名称中选择。' : '服务商未返回模型列表，可以手动填写模型名称。'
    } else if (kind === 'test') {
      const result = await window.studyBridge.testAIConfig(input)
      if (disposed || id !== operationId) return
      tested.value = true
      status.value = '连接成功 · ' + result.model
    } else {
      const config = await window.studyBridge.saveAIConfig(input)
      if (disposed || id !== operationId) return
      savedConfig.value = config
      form.apiKey = ''
      showKey.value = false
      emit('saved', config)
      emit('close')
    }
  } catch (reason) {
    if (!disposed && id === operationId) error.value = message(reason)
  } finally {
    if (!disposed && id === operationId) operation.value = ''
  }
}
function close() {
  if (operation.value !== 'save') emit('close')
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close(); return }
  if (event.key !== 'Tab' || !dialog.value) return
  const controls = Array.from(dialog.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
    .filter(element => element.getClientRects().length)
  const first = controls[0], last = controls[controls.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  try {
    const config = await window.studyBridge.getAIConfig()
    if (disposed) return
    savedConfig.value = config
    const selected = aiProviders.find(item => item.id === config.provider) ?? aiProviders[0]
    form.provider = config.provider
    form.baseUrl = config.baseUrl || selected.baseUrl
    form.model = config.model || selected.defaultModel
    advanced.value = config.provider === 'custom'
  } catch (reason) { if (!disposed) error.value = message(reason) }
  finally {
    if (!disposed) {
      loading.value = false
      await nextTick()
      providerInput.value?.focus()
    }
  }
})
onBeforeUnmount(() => {
  disposed = true
  operationId++
  form.apiKey = ''
  previousFocus?.focus({ preventScroll: true })
})
</script>

<template>
  <div class="ai-settings-backdrop" @click.self="close" @keydown="keyboard">
    <section ref="dialog" class="ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-settings-title">
      <header class="settings-heading">
        <div><h2 id="provider-settings-title">AI 设置</h2><p>选择模型服务商，配置你的 API。</p></div>
        <button type="button" class="dismiss-settings" aria-label="关闭 AI 设置" :disabled="operation === 'save'" @click="close">×</button>
      </header>
      <form class="provider-form" @submit.prevent="run('save')">
        <div class="settings-fields">
          <label class="field-label" for="ai-provider">模型服务商</label>
          <select id="ai-provider" ref="providerInput" :value="form.provider" :disabled="busy" @change="changeProvider">
            <option v-for="item in aiProviders" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>

          <div class="field-heading"><label class="field-label" for="provider-key">API Key</label>
            <span v-if="canKeepKey && !form.clearApiKey && !form.apiKey" class="saved-key-state">已保存</span>
            <span v-else-if="!provider.requiresKey" class="field-note">可留空</span>
          </div>
          <div class="key-input">
            <input id="provider-key" v-model="form.apiKey" :type="showKey ? 'text' : 'password'" :disabled="busy || form.clearApiKey"
              :placeholder="canKeepKey && !form.clearApiKey ? '已保存密钥，留空继续使用' : '填写服务商提供的 API Key'"
              autocomplete="off" autocapitalize="off" spellcheck="false" @input="clearFeedback" />
            <button type="button" :disabled="busy || !form.apiKey" :aria-pressed="showKey" @click="showKey=!showKey">{{ showKey ? '隐藏' : '显示' }}</button>
          </div>
          <label v-if="canKeepKey" class="clear-key"><input v-model="form.clearApiKey" type="checkbox" :disabled="busy" @change="clearFeedback" />移除已保存的密钥</label>

          <div class="field-heading"><label class="field-label" for="provider-model">模型名称</label>
            <button class="fetch-models" type="button" :disabled="busy || needsKey || !form.baseUrl.trim()" @click="run('models')">{{ operation === 'models' ? '正在获取…' : '获取模型' }}</button>
          </div>
          <input id="provider-model" v-model="form.model" list="provider-model-options" :disabled="busy" placeholder="选择或填写模型名称"
            autocomplete="off" autocapitalize="off" spellcheck="false" @input="clearFeedback" />
          <datalist id="provider-model-options"><option v-for="model in models" :key="model" :value="model" /></datalist>

          <details class="advanced-settings" :open="advanced" @toggle="advanced=($event.target as HTMLDetailsElement).open">
            <summary>API 地址</summary>
            <div class="endpoint-field"><label class="field-label" for="provider-endpoint">基础地址</label>
              <input id="provider-endpoint" :value="form.baseUrl" :disabled="busy" type="url" placeholder="https://api.example.com/v1"
                autocomplete="off" autocapitalize="off" spellcheck="false" @input="changeEndpoint" />
              <small>可填写服务商的地区地址或兼容接口地址。</small>
            </div>
          </details>
          <p v-if="error" class="settings-feedback feedback-error" role="alert">{{ error }}</p>
          <p v-else-if="loading" class="settings-feedback" role="status">正在读取配置…</p>
          <p v-else-if="status" class="settings-feedback" :class="{'feedback-success':tested}" role="status">{{ status }}</p>
          <p class="settings-storage-note">配置保存在本机 <code>.env</code>。发送消息、生成摘要和打磨回答会使用此服务。</p>
        </div>
        <footer class="settings-footer">
          <button type="button" class="test-connection" :disabled="busy || needsKey || !form.baseUrl.trim() || !form.model.trim()" @click="run('test')">{{ operation === 'test' ? '正在测试…' : '测试连接' }}</button>
          <div><button type="button" class="cancel-settings" :disabled="operation === 'save'" @click="close">取消</button>
            <button type="submit" class="save-provider" :disabled="!canSave">{{ operation === 'save' ? '正在保存…' : '保存配置' }}</button></div>
        </footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.ai-settings-backdrop { position: fixed; z-index: 30; inset: 0; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--rove-accent) 25.1%, transparent); backdrop-filter: blur(6px); }
.ai-settings-dialog { display: flex; flex-direction: column; width: 472px; max-width: 100%; max-height: calc(100vh - 48px); overflow: hidden; border: 1px solid color-mix(in srgb, var(--rove-surface) 63.9%, transparent); border-radius: 17px; background: var(--rove-surface); box-shadow: 0 24px 80px color-mix(in srgb, var(--rove-accent) 16.1%, transparent), 0 2px 8px color-mix(in srgb, var(--rove-accent) 7.1%, transparent); color: var(--rove-text); }
.settings-heading { display: flex; align-items: flex-start; justify-content: space-between; flex: none; padding: 27px 28px 21px; }
.settings-heading h2 { margin: 0; font-size: calc(21px * var(--rove-font-scale, 1)); line-height: 1.3; letter-spacing: -.45px; font-weight: 600; }
.settings-heading p { margin: 9px 0 0; color: var(--rove-muted); font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.6; }
.dismiss-settings { flex: none; width: 26px; height: 26px; margin-top: -3px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--rove-secondary); font-size: calc(23px * var(--rove-font-scale, 1)); line-height: 1; }
.dismiss-settings:hover { background: var(--rove-accent-soft); color: var(--rove-secondary); }
.provider-form { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
.settings-fields { min-height: 0; overflow: auto; padding: 0 28px 23px; }
.field-label { display: block; margin: 0 0 7px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650); }
.settings-fields > select, .settings-fields > input, .key-input, .endpoint-field > input { width: 100%; min-width: 0; height: 38px; border: 1px solid var(--rove-line); border-radius: 8px; background: var(--rove-surface); color: var(--rove-text); font-size: calc(12px * var(--rove-font-scale, 1)); box-shadow: 0 1px 2px color-mix(in srgb, var(--rove-accent) 1.2%, transparent); }
.settings-fields > select, .settings-fields > input, .endpoint-field > input { padding: 8px 11px; }
.settings-fields > select { margin-bottom: 23px; }
.field-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 22px; }
.field-heading:first-of-type { margin-top: 0; }
.saved-key-state, .field-note { margin-bottom: 7px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.key-input { display: flex; align-items: center; overflow: hidden; }
.key-input input { flex: 1; width: 0; min-width: 0; height: 100%; padding: 8px 11px; border: 0; background: transparent; color: inherit; font-size: calc(12px * var(--rove-font-scale, 1)); outline: none; }
.key-input:focus-within { border-color: var(--rove-accent); outline: 2px solid color-mix(in srgb, var(--rove-accent) 8.2%, transparent); }
.key-input button { flex: none; padding: 5px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--rove-accent-strong); font-size: calc(11px * var(--rove-font-scale, 1)); }
.key-input button:hover:enabled { color: var(--rove-accent-strong); }
input::placeholder { color: var(--rove-muted); }
.clear-key { display: flex; align-items: center; gap: 6px; margin-top: 9px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.6; }
.clear-key input { margin: 0; accent-color: var(--rove-accent); }
.fetch-models { margin: -3px 0 4px; padding: 3px 0 3px 8px; border: 0; background: transparent; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.fetch-models:hover:enabled { color: var(--rove-text); }
.advanced-settings { margin-top: 20px; border-top: 1px solid var(--rove-line); padding-top: 14px; color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); }
.advanced-settings summary { width: fit-content; cursor: pointer; }
.endpoint-field { padding-top: 14px; }
.endpoint-field small { display: block; margin-top: 7px; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.7; }
.settings-feedback { margin: 16px 0 0; padding: 9px 11px; border: 1px solid var(--rove-line); border-radius: 7px; background: var(--rove-rail); color: var(--rove-secondary); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.7; overflow-wrap: anywhere; }
.feedback-error { border-color: #efdce0; background: #fbf1f3; color: #a46a7a; }
.feedback-success { border-color: #ded4e9; color: #73538d; }
.settings-storage-note { margin: 18px 0 0; color: var(--rove-muted); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.8; }
.settings-storage-note code { color: var(--rove-secondary); font: inherit; }
.settings-footer { display: flex; flex: none; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px; padding: 17px 28px; border-top: 1px solid var(--rove-line); background: var(--rove-canvas); border-radius: 0 0 17px 17px; }
.settings-footer > div { display: flex; gap: 8px; }
.settings-footer button { min-height: 32px; padding: 7px 12px; border: 1px solid var(--rove-line); border-radius: 7px; background: var(--rove-surface); color: var(--rove-accent-strong); font-size: calc(11px * var(--rove-font-scale, 1)); line-height: 1.4; }
.settings-footer .cancel-settings { border-color: transparent; background: transparent; color: var(--rove-secondary); }
.settings-footer .save-provider { border-color: var(--rove-line); background: var(--rove-accent-strong); color: #fff; box-shadow: 0 1px 2px color-mix(in srgb, var(--rove-accent) 12.5%, transparent); }
.settings-footer .save-provider:hover:enabled { background: var(--rove-accent-strong); }
.settings-footer .test-connection:hover:enabled { border-color: var(--rove-accent); background: var(--rove-surface); }
button:disabled, input:disabled, select:disabled { cursor: default; opacity: .5; }
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--rove-accent); outline-offset: 3px; }
.key-input input:focus-visible { outline: none; }
@media (max-height: 760px) {
  .settings-heading { padding-top: 22px; padding-bottom: 16px; }
  .settings-fields { padding-bottom: 18px; }
  .field-heading { margin-top: 17px; }
  .advanced-settings { margin-top: 16px; }
}
@media (prefers-reduced-motion: no-preference) {
  button { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease; }
}
</style>
