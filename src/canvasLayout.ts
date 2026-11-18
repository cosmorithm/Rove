export interface CanvasPoint { x: number; y: number }
export type CanvasPositions = Record<string, CanvasPoint>
export interface CanvasLayoutNode extends CanvasPoint {
  key: string
  width: number
  height: number
  parentKey?: string
}

const storagePrefix = 'rove-map-layout-v1:'
const coordinateLimit = 1_000_000

export function clampCanvasPoint(point: CanvasPoint): CanvasPoint {
  return {
    x: Math.max(-coordinateLimit, Math.min(coordinateLimit, point.x)),
    y: Math.max(-coordinateLimit, Math.min(coordinateLimit, point.y)),
  }
}

function positions(value: unknown): CanvasPositions {
  const result: CanvasPositions = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[bq]\/.{1,512}$/u.test(key) || !raw || typeof raw !== 'object') continue
    const point = raw as Partial<CanvasPoint>
    if (typeof point.x !== 'number' || typeof point.y !== 'number' ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        Math.abs(point.x) > coordinateLimit || Math.abs(point.y) > coordinateLimit) continue
    result[key] = { x: point.x, y: point.y }
  }
  return result
}

export function readCanvasPositions(scope: string, storage?: Pick<Storage, 'getItem'>): CanvasPositions {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    const saved = JSON.parse(source?.getItem(storagePrefix + scope) ?? 'null')
    return saved?.version === 1 ? positions(saved.positions) : {}
  } catch { return {} }
}

export function saveCanvasPositions(scope: string, value: CanvasPositions, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    if (!target) return false
    target.setItem(storagePrefix + scope, JSON.stringify({ version: 1, positions: positions(value) }))
    return true
  } catch { return false }
}

/** Automatic nodes are parent-first. Saved positions never mutate their content or ancestry. */
export function resolveCanvasLayout(nodes: readonly CanvasLayoutNode[], saved: CanvasPositions, margin = 40) {
  const resolved: CanvasPositions = {}
  const byKey = new Map(nodes.map(node => [node.key, node]))
  let minX = 0, minY = 0, right = 0, bottom = 0
  for (const node of nodes) {
    const parent = node.parentKey ? byKey.get(node.parentKey) : undefined
    const parentPosition = node.parentKey ? resolved[node.parentKey] : undefined
    // Newly created nodes start near their parent's actual location, not its old automatic position.
    const point = saved[node.key] ?? {
      x: node.x + (parent && parentPosition ? parentPosition.x - parent.x : 0),
      y: node.y + (parent && parentPosition ? parentPosition.y - parent.y : 0),
    }
    resolved[node.key] = { ...point }
    minX = Math.min(minX, point.x - margin)
    minY = Math.min(minY, point.y - margin)
    right = Math.max(right, point.x + node.width + margin)
    bottom = Math.max(bottom, point.y + node.height + margin)
  }
  const links: { key: string; child: string; path: string }[] = []
  for (const node of nodes) {
    const parent = node.parentKey ? byKey.get(node.parentKey) : undefined
    if (!parent) continue
    const from = resolved[parent.key], to = resolved[node.key]
    const direction = to.x + node.width / 2 >= from.x + parent.width / 2 ? 1 : -1
    const x = from.x + (direction > 0 ? parent.width : 0) - minX
    const endX = to.x + (direction > 0 ? 0 : node.width) - minX
    const y = from.y + parent.height / 2 - minY, endY = to.y + node.height / 2 - minY
    const bend = Math.max(24, Math.abs(endX - x) / 2)
    links.push({ key: node.key, child: node.key,
      path: `M ${x} ${y} C ${x + direction * bend} ${y} ${endX - direction * bend} ${endY} ${endX} ${endY}` })
  }
  return { positions: resolved, links, minX, minY, width: right - minX, height: bottom - minY }
}
