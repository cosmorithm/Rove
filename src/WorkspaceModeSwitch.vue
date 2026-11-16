<script setup lang="ts">
defineProps<{ modelValue: 'chat' | 'coding' }>()
const emit = defineEmits<{ 'update:modelValue': [value: 'chat' | 'coding'] }>()
</script>

<template>
  <nav class="workspace-modes" aria-label="工作模式">
    <button type="button" :aria-pressed="modelValue === 'chat'" @click="emit('update:modelValue', 'chat')">Chat</button>
    <button type="button" :aria-pressed="modelValue === 'coding'" @click="emit('update:modelValue', 'coding')">Coding</button>
  </nav>
</template>

<style scoped>
.workspace-modes {
  display: flex;
  flex: none;
  gap: 3px;
  margin: 0 0 18px;
  padding: 3px;
  border: 1px solid #e3d9eb;
  border-radius: 9px;
  background: #e9e4f1;
}
.workspace-modes button {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #8d8296;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
}
.workspace-modes button:hover { color: #5b5165; }
.workspace-modes button[aria-pressed=true] {
  border-color: #dfd5ea;
  background: white;
  color: #554c5e;
  box-shadow: 0 1px 3px #2e28340a;
}
.workspace-modes button:focus-visible { outline: 2px solid var(--rove-accent); outline-offset: 2px; }
</style>
