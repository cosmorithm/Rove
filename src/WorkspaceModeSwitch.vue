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
  border: 1px solid var(--rove-line);
  border-radius: 9px;
  background: var(--rove-accent-soft);
}
.workspace-modes button {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--rove-accent-strong);
  font: inherit;
  font-size: calc(11px * var(--rove-font-scale, 1));
  font-weight: clamp(400, calc(var(--rove-font-weight, 450) + 50), 650);
}
.workspace-modes button:hover { color: var(--rove-accent-strong); }
.workspace-modes button[aria-pressed=true] {
  border-color: var(--rove-line);
  background: var(--rove-surface);
  color: var(--rove-accent-strong);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--rove-text) 3.9%, transparent);
}
.workspace-modes button:focus-visible { outline: 2px solid var(--rove-accent); outline-offset: 2px; }
</style>
