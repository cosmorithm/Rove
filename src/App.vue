<script setup lang="ts">
import { ref, watch } from 'vue'
import ChatWorkspace from './ChatWorkspace.vue'
import CodingWorkspace from './CodingWorkspace.vue'
import WorkspaceModeSwitch from './WorkspaceModeSwitch.vue'

function initialMode(): 'chat' | 'coding' {
  // The earlier "study" value opens Chat while preserving its library and context settings.
  try { return localStorage.getItem('rove-workspace-mode') === 'coding' ? 'coding' : 'chat' }
  catch { return 'chat' }
}
const mode = ref(initialMode())
watch(mode, value => {
  try { localStorage.setItem('rove-workspace-mode', value) } catch { /* Mode switching remains available. */ }
})
</script>

<template>
  <KeepAlive>
    <component :is="mode === 'coding' ? CodingWorkspace : ChatWorkspace">
      <template #mode-switch><WorkspaceModeSwitch v-model="mode" /></template>
    </component>
  </KeepAlive>
</template>
