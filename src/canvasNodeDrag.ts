import type { CanvasPoint } from './canvasLayout'

type Options = {
  position(key: string): CanvasPoint | undefined
  point(event: PointerEvent): CanvasPoint | undefined
  onStart(key: string): void
  onMove(key: string, point: CanvasPoint): void
  onEnd(key: string): void
  onActive(key?: string): void
}

export function createCanvasNodeDrag(options: Options) {
  let drag: { handle: HTMLElement; id: number; key: string; x: number; y: number; offset: CanvasPoint; moved: boolean } | undefined
  let suppressedClick: string | undefined

  function cancel() {
    if (!drag) return
    const { handle, id, key, moved } = drag
    drag = undefined
    if (moved) suppressedClick = key
    options.onActive()
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id)
    // A cancelled capture or window blur keeps the last visible position, rather than losing it.
    if (moved) options.onEnd(key)
  }

  function start(event: PointerEvent, key: string) {
    if (drag || !event.isPrimary || event.button !== 0) return
    const target = event.target as Element | null
    if (target?.closest('a, input, textarea, select, [contenteditable]')) return
    const position = options.position(key), point = options.point(event)
    if (!position || !point) return
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    drag = { handle, id: event.pointerId, key, x: event.clientX, y: event.clientY,
      offset: { x: point.x - position.x, y: point.y - position.y }, moved: false }
    suppressedClick = undefined
    handle.focus({ preventScroll: true })
    event.preventDefault()
    event.stopPropagation()
  }

  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return
    if (!(event.buttons & 1)) { cancel(); return }
    // Small hand movements remain clicks; crossing this screen-pixel threshold starts a drag.
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return
    const point = options.point(event)
    if (!point) { cancel(); return }
    if (!drag.moved) {
      drag.moved = true
      options.onStart(drag.key)
      options.onActive(drag.key)
    }
    options.onMove(drag.key, { x: point.x - drag.offset.x, y: point.y - drag.offset.y })
    event.preventDefault()
    event.stopPropagation()
  }

  function finish(event: PointerEvent) {
    if (event.pointerId !== drag?.id) return
    cancel()
    event.stopPropagation()
  }

  function consumeClick(event: MouseEvent, key: string) {
    if (suppressedClick !== key) return false
    suppressedClick = undefined
    // Keyboard activation and programmatic clicks must not be blocked after a cancelled drag.
    if (event.detail === 0) return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  return { start, move, finish, cancel, consumeClick, get active() { return !!drag } }
}
