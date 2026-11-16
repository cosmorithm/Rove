<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { defaultAppearance, themePresets, type AppearanceSettings } from './appearance'

const props = defineProps<{ modelValue: AppearanceSettings }>()
const emit = defineEmits<{ 'update:modelValue': [value: AppearanceSettings]; close: [] }>()
const dialog = ref<HTMLElement>()
const closeButton = ref<HTMLButtonElement>()
const fontSizes = [14, 15, 16, 17] as const
const weights = [{ value: 400, label: '常规' }, { value: 450, label: '适中' },
  { value: 500, label: '中等' }, { value: 550, label: '较粗' }] as const
const fonts = [{ value: 'system', label: '系统字体' }, { value: 'serif', label: '宋体阅读' },
  { value: 'rounded', label: '圆润字体' }] as const
const fontFamilies = {
  system: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  serif: '"Songti SC", STSong, "Times New Roman", serif',
  rounded: 'ui-rounded, "Hiragino Maru Gothic ProN", "PingFang SC", sans-serif',
}
const previewStyle = computed(() => {
  const selected: AppearanceSettings = props.modelValue
  return {
    '--rove-preview-scale': String(selected.fontSize / 14),
    '--rove-preview-weight': String(selected.weight),
    '--rove-preview-family': fontFamilies[selected.fontStyle],
  }
})
let previousFocus: HTMLElement | null = null

function update(value: Partial<AppearanceSettings>) {
  emit('update:modelValue', { ...props.modelValue, ...value })
}
function reset() { emit('update:modelValue', { ...defaultAppearance }) }
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
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
  await nextTick()
  closeButton.value?.focus()
})
onBeforeUnmount(() => previousFocus?.focus({ preventScroll: true }))
</script>

<template>
  <div class="appearance-backdrop" @click.self="emit('close')" @keydown="keyboard">
    <section ref="dialog" class="appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <header class="appearance-heading">
        <div><h2 id="appearance-title">外观</h2><p>调整配色和阅读文字，修改即时生效。</p></div>
        <button ref="closeButton" type="button" class="close-appearance" aria-label="关闭外观设置" @click="emit('close')">×</button>
      </header>
      <div class="appearance-fields">
        <fieldset class="theme-field">
          <legend>界面配色</legend>
          <div class="theme-options">
            <button v-for="theme in themePresets" :key="theme.id" type="button" :aria-pressed="modelValue.theme === theme.id"
              :aria-label="theme.name + '配色'" @click="update({theme:theme.id})">
              <span class="theme-swatch" :style="{background:theme.swatch}" aria-hidden="true"><span v-if="modelValue.theme === theme.id">✓</span></span>
              <span>{{ theme.name }}</span>
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>字号</legend>
          <div class="appearance-segment size-options">
            <button v-for="size in fontSizes" :key="size" type="button" :aria-pressed="modelValue.fontSize === size" @click="update({fontSize:size})">{{ size }}<small>px</small></button>
          </div>
        </fieldset>
        <fieldset>
          <legend>字体</legend>
          <div class="appearance-segment">
            <button v-for="font in fonts" :key="font.value" type="button" :aria-pressed="modelValue.fontStyle === font.value"
              :style="{fontFamily:fontFamilies[font.value]}" @click="update({fontStyle:font.value})">{{ font.label }}</button>
          </div>
        </fieldset>
        <fieldset>
          <legend>文字深浅</legend>
          <div class="appearance-segment">
            <button type="button" :aria-pressed="modelValue.contrast === 'standard'" @click="update({contrast:'standard'})">标准</button>
            <button type="button" :aria-pressed="modelValue.contrast === 'strong'" @click="update({contrast:'strong'})">深色清晰</button>
          </div>
        </fieldset>
        <fieldset>
          <legend>字重</legend>
          <div class="appearance-segment">
            <button v-for="weight in weights" :key="weight.value" type="button" :aria-pressed="modelValue.weight === weight.value"
              :style="{fontWeight:weight.value}" @click="update({weight:weight.value})">{{ weight.label }}</button>
          </div>
        </fieldset>
        <section class="appearance-preview" :style="previewStyle" aria-label="文字外观预览">
          <small>阅读预览</small>
          <p>从一个问题出发，沿着想法继续探索。</p>
          <span>Rove keeps your ideas connected.</span>
        </section>
      </div>
      <footer class="appearance-footer">
        <button type="button" class="reset-appearance" @click="reset">恢复默认</button>
        <button type="button" class="finish-appearance" @click="emit('close')">完成</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.appearance-backdrop { position: fixed; z-index: 40; inset: 0; display: grid; place-items: center; padding: 24px; background: #25212e40; backdrop-filter: blur(6px); }
.appearance-dialog { display: flex; flex-direction: column; width: 480px; max-width: 100%; max-height: calc(100vh - 48px); overflow: hidden; border: 1px solid var(--rove-line, #e8e2ee); border-radius: 17px; background: var(--rove-surface, #fefeff); color: var(--rove-text, #383342); box-shadow: 0 24px 80px #30213f29, 0 2px 8px #30213f12; }
.appearance-heading { display: flex; align-items: flex-start; justify-content: space-between; flex: none; gap: 16px; padding: 25px 28px 22px; }
.appearance-heading h2 { margin: 0; font-size: calc(21px * var(--rove-font-scale, 1)); font-weight: 600; line-height: 1.3; letter-spacing: -.4px; }
.appearance-heading p { margin: 8px 0 0; color: var(--rove-muted, #82778e); font-size: calc(12px * var(--rove-font-scale, 1)); line-height: 1.7; }
.close-appearance { flex: none; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--rove-muted, #82778e); font-size: calc(23px * var(--rove-font-scale, 1)); line-height: 1; }
.close-appearance:hover { background: var(--rove-accent-soft, #eee8f7); color: var(--rove-accent, #80649f); }
.appearance-fields { min-height: 0; overflow: auto; padding: 0 28px 23px; }
fieldset { min-width: 0; margin: 0 0 20px; padding: 0; border: 0; }
legend { margin-bottom: 9px; padding: 0; color: var(--rove-text, #383342); font-size: calc(12px * var(--rove-font-scale, 1)); font-weight: 550; }
.theme-options { display: flex; justify-content: space-between; gap: 8px; }
.theme-options button { flex: 1; min-width: 0; padding: 10px 7px; border: 1px solid transparent; border-radius: 9px; background: var(--rove-canvas, #f8f7fc); color: var(--rove-muted, #82778e); font-size: calc(11px * var(--rove-font-scale, 1)); font-weight: var(--rove-font-weight, 450); }
.theme-options button:hover { border-color: var(--rove-line, #e8e2ee); }
.theme-options button[aria-pressed=true] { border-color: var(--rove-accent, #80649f); background: var(--rove-accent-soft, #eee8f7); color: var(--rove-text, #383342); }
.theme-swatch { display: grid; place-items: center; width: 32px; height: 32px; margin: 0 auto 8px; border: 1px solid #ffffff70; border-radius: 50%; color: #fff; box-shadow: inset 0 0 0 1px #00000008; font-size: calc(17px * var(--rove-font-scale, 1)); }
.theme-swatch > span { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #302b3847; }
.appearance-segment { display: flex; gap: 3px; padding: 3px; border: 1px solid var(--rove-line, #e8e2ee); border-radius: 8px; background: var(--rove-canvas, #f8f7fc); }
.appearance-segment button { flex: 1; min-width: 0; padding: 7px 5px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--rove-muted, #82778e); font-size: calc(11px * var(--rove-font-scale, 1)); font-weight: var(--rove-font-weight, 450); line-height: 1.5; }
.appearance-segment button[aria-pressed=true] { border-color: var(--rove-line, #e8e2ee); background: var(--rove-surface, #fefeff); color: var(--rove-text, #383342); box-shadow: 0 1px 3px #30213f0a; }
.appearance-segment button:hover:not([aria-pressed=true]) { color: var(--rove-text, #383342); background: var(--rove-accent-soft, #eee8f7); }
.size-options button { font-size: calc(13px * var(--rove-font-scale, 1)); font-variant-numeric: tabular-nums; }
.size-options small { margin-left: 3px; color: var(--rove-muted, #82778e); font-size: calc(9px * var(--rove-font-scale, 1)); }
.appearance-preview { padding: 16px; border: 1px solid var(--rove-line, #e8e2ee); border-radius: 10px; background: var(--rove-canvas, #f8f7fc); }
.appearance-preview > small { display: block; margin-bottom: 10px; color: var(--rove-muted, #82778e); font: 500 calc(10px * var(--rove-font-scale, 1))/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
.appearance-preview p { margin: 0 0 8px; color: var(--rove-text, #383342); font-family: var(--rove-preview-family); font-size: calc(14px * var(--rove-preview-scale)); font-weight: var(--rove-preview-weight); line-height: 1.8; }
.appearance-preview > span { color: var(--rove-muted, #82778e); font-family: var(--rove-preview-family); font-size: calc(12px * var(--rove-preview-scale)); font-weight: var(--rove-preview-weight); line-height: 1.8; }
.appearance-footer { display: flex; align-items: center; justify-content: space-between; flex: none; gap: 16px; padding: 16px 28px; border-top: 1px solid var(--rove-line, #e8e2ee); background: var(--rove-canvas, #f8f7fc); }
.appearance-footer button { padding: 7px 13px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--rove-muted, #82778e); font-size: calc(11px * var(--rove-font-scale, 1)); font-weight: var(--rove-font-weight, 450); line-height: 1.5; }
.appearance-footer .reset-appearance:hover { background: var(--rove-accent-soft, #eee8f7); color: var(--rove-text, #383342); }
.appearance-footer .finish-appearance { background: var(--rove-accent-strong, #756095); color: #fff; box-shadow: 0 1px 2px #30213f18; }
.appearance-footer .finish-appearance:hover { filter: brightness(.95); }
button:focus-visible { outline: 2px solid var(--rove-accent, #80649f); outline-offset: 3px; }
@media (max-height: 760px) { .appearance-heading { padding-top: 20px; padding-bottom: 17px; } fieldset { margin-bottom: 17px; } }
@media (prefers-reduced-motion: no-preference) { button { transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; } }
</style>
