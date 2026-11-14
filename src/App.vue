<script setup lang="ts">
import { ref, watch } from 'vue'
import StudyWorkspace from './StudyWorkspace.vue'
import CodingWorkspace from './CodingWorkspace.vue'
import WorkspaceModeSwitch from './WorkspaceModeSwitch.vue'

function initialMode(): 'study' | 'coding' {
  try { return localStorage.getItem('rove-workspace-mode') === 'coding' ? 'coding' : 'study' }
  catch { return 'study' }
}
const mode = ref(initialMode())
watch(mode, value => {
  try { localStorage.setItem('rove-workspace-mode', value) } catch { /* Mode switching remains available. */ }
})
</script>

<template>
  <KeepAlive>
    <component :is="mode === 'coding' ? CodingWorkspace : StudyWorkspace">
      <template #mode-switch><WorkspaceModeSwitch v-model="mode" /></template>
    </component>
  </KeepAlive>
</template>
