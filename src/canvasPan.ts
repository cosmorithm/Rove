export function createCanvasPan(onChange: (active: boolean) => void) {
  let drag: { view: HTMLElement; id: number; x: number; y: number; left: number; top: number } | undefined

  function cancel() {
    if (!drag) return
    const { view, id } = drag
    drag = undefined
    onChange(false)
    if (view.hasPointerCapture(id)) view.releasePointerCapture(id)
  }

  function start(event: PointerEvent) {
    // Touch keeps native scrolling; nodes and other controls retain their own interactions.
    if (drag || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch') return
    const target = event.target as Element | null
    if (target?.closest('button, a, input, textarea, select, [contenteditable]')) return
    const view = event.currentTarget as HTMLElement
    const bounds = view.getBoundingClientRect()
    const left = bounds.left + view.clientLeft, top = bounds.top + view.clientTop
    // Do not capture a press on a native scrollbar.
    if (event.clientX < left || event.clientX >= left + view.clientWidth ||
        event.clientY < top || event.clientY >= top + view.clientHeight) return
    view.setPointerCapture(event.pointerId)
    drag = { view, id: event.pointerId, x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop }
    onChange(true)
    event.preventDefault()
  }

  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return
    if (!(event.buttons & 1)) { cancel(); return }
    // Scroll offsets use screen pixels, so dragging stays 1:1 at every zoom level.
    drag.view.scrollLeft = drag.left - (event.clientX - drag.x)
    drag.view.scrollTop = drag.top - (event.clientY - drag.y)
    event.preventDefault()
  }

  function finish(event: PointerEvent) {
    if (event.pointerId === drag?.id) cancel()
  }

  return { start, move, finish, cancel }
}
