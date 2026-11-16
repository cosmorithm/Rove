export interface AppearanceSettings {
  theme: 'lavender' | 'paper' | 'blue' | 'sage'
  fontSize: 14 | 15 | 16 | 17
  fontStyle: 'system' | 'serif' | 'rounded'
  contrast: 'standard' | 'strong'
  weight: 400 | 450 | 500 | 550
}

export const defaultAppearance: Readonly<AppearanceSettings> = Object.freeze({
  theme: 'lavender', fontSize: 15, fontStyle: 'system', contrast: 'strong', weight: 450,
})

export const themePresets: readonly { id: AppearanceSettings['theme']; name: string; swatch: string }[] = [
  { id: 'lavender', name: '淡紫', swatch: '#c8b5df' },
  { id: 'paper', name: '纸白', swatch: '#d9d3c7' },
  { id: 'blue', name: '雾蓝', swatch: '#a9c2dd' },
  { id: 'sage', name: '鼠尾草', swatch: '#b3c9b7' },
]

const storageKey = 'rove-appearance-v1'

function choice<T>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback
}

function settings(value: unknown): AppearanceSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AppearanceSettings> : {}
  return {
    theme: choice<AppearanceSettings['theme']>(input.theme, ['lavender', 'paper', 'blue', 'sage'], defaultAppearance.theme),
    fontSize: choice<AppearanceSettings['fontSize']>(input.fontSize, [14, 15, 16, 17], defaultAppearance.fontSize),
    fontStyle: choice<AppearanceSettings['fontStyle']>(input.fontStyle, ['system', 'serif', 'rounded'], defaultAppearance.fontStyle),
    contrast: choice<AppearanceSettings['contrast']>(input.contrast, ['standard', 'strong'], defaultAppearance.contrast),
    weight: choice<AppearanceSettings['weight']>(input.weight, [400, 450, 500, 550], defaultAppearance.weight),
  }
}

export function readAppearance(storage?: Pick<Storage, 'getItem'>): AppearanceSettings {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    return settings(JSON.parse(source?.getItem(storageKey) ?? 'null'))
  } catch { return { ...defaultAppearance } }
}

/** A disabled store still permits appearance changes for the current session. */
export function saveAppearance(value: AppearanceSettings, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    if (!target) return false
    target.setItem(storageKey, JSON.stringify(settings(value)))
    return true
  } catch { return false }
}

export function applyAppearance(value: AppearanceSettings, element?: HTMLElement): void {
  const target = element ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  if (!target) return
  const selected = settings(value)
  target.setAttribute('data-rove-theme', selected.theme)
  target.setAttribute('data-rove-contrast', selected.contrast)
  target.setAttribute('data-rove-font', selected.fontStyle)
  target.style.setProperty('--rove-font-scale', String(selected.fontSize / 14))
  target.style.setProperty('--rove-font-weight', String(selected.weight))
}
