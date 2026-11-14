<script setup lang="ts">
defineProps<{ modelValue: 'study' | 'coding' }>()
const emit = defineEmits<{ 'update:modelValue': [value: 'study' | 'coding'] }>()
</script>

<template>
  <nav class="workspace-modes" aria-label="工作模式">
    <button type="button" :aria-pressed="modelValue === 'study'" @click="emit('update:modelValue', 'study')">学习</button>
    <button type="button" :aria-pressed="modelValue === 'coding'" @click="emit('update:modelValue', 'coding')">Coding</button>
  </nav>
</template>

<style scoped>
.workspace-modes { display:flex; flex:none; gap:3px; padding:3px; margin:0 0 16px; border:1px solid #d9e1d5; border-radius:8px; background:#e7ece2; }
.workspace-modes button { flex:1; border:0; border-radius:5px; padding:6px 8px; background:transparent; color:#566750; font:inherit; font-size:12px; }
.workspace-modes button[aria-pressed=true] { color:#294f36; background:#fff; box-shadow:0 1px 3px #314a3020; }
.workspace-modes button:focus-visible { outline:2px solid #64896b; outline-offset:-2px; }
</style>
