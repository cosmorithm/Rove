<script setup lang="ts">
import { provide, ref, watch } from 'vue'
import ChatWorkspace from './ChatWorkspace.vue'
import CodingWorkspace from './CodingWorkspace.vue'
import WorkspaceModeSwitch from './WorkspaceModeSwitch.vue'
import AppearanceDialog from './AppearanceDialog.vue'
import { applyAppearance, readAppearance, saveAppearance } from './appearance'

function initialMode(): 'chat' | 'coding' {
  // The earlier "study" value opens Chat while preserving its library and context settings.
  try { return localStorage.getItem('rove-workspace-mode') === 'coding' ? 'coding' : 'chat' }
  catch { return 'chat' }
}
const appearance = ref(readAppearance())
const appearanceOpen = ref(false)
const appearanceError = ref('')
provide('rove-appearance', appearance)
applyAppearance(appearance.value)
watch(appearance, value => {
  applyAppearance(value)
  appearanceError.value = saveAppearance(value) ? '' : '外观已应用，本机设置暂未保存。'
}, { deep: true })

const mode = ref(initialMode())
watch(mode, value => {
  try { localStorage.setItem('rove-workspace-mode', value) } catch { /* Mode switching remains available. */ }
})
</script>

<template>
  <KeepAlive>
    <component :is="mode === 'coding' ? CodingWorkspace : ChatWorkspace">
      <template #mode-switch><WorkspaceModeSwitch v-model="mode" /></template>
      <template #appearance>
        <button type="button" class="appearance-launch" @click="appearanceOpen=true"><span aria-hidden="true">◐</span>外观设置</button>
      </template>
    </component>
  </KeepAlive>
  <AppearanceDialog v-if="appearanceOpen" v-model="appearance" @close="appearanceOpen=false" />
  <p v-if="appearanceError" class="appearance-storage-error" role="status">{{ appearanceError }}</p>
</template>

<style scoped>
.appearance-launch { display: flex; align-items: center; gap: 9px; width: 100%; margin-top: 6px; padding: 9px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--rove-secondary); text-align: left; font: inherit; font-size: calc(12px * var(--rove-font-scale, 1)); }
.appearance-launch span { width: 17px; text-align: center; font-size: calc(17px * var(--rove-font-scale, 1)); }
.appearance-launch:hover { background: var(--rove-accent-soft); }
.appearance-storage-error { position: fixed; z-index: 50; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 12px 16px; border: 1px solid var(--rove-line); border-radius: 9px; background: var(--rove-surface); color: var(--rove-text); font-size: calc(12px * var(--rove-font-scale, 1)); box-shadow: 0 5px 24px #30204015; }
</style>
