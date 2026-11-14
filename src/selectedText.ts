// Rendered KaTeX contains both visual glyphs and hidden MathML. Treat an
// intersected formula as one source expression, including in partial selections.
export function selectedAnswerText(root: HTMLElement, range: Range): string {
  const formulaSelector = '.folio-math-inline,.folio-math-block'
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element : range.startContainer.parentElement
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? range.endContainer as Element : range.endContainer.parentElement
  const first = start?.closest(formulaSelector)
  const last = end?.closest(formulaSelector)
  const copy = range.cloneRange()
  if (first && root.contains(first)) copy.setStartBefore(first)
  if (last && root.contains(last)) copy.setEndAfter(last)
  const fragment = copy.cloneContents()
  for (const formula of fragment.querySelectorAll(formulaSelector)) {
    const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    const delimiter = formula.classList.contains('folio-math-block') ? '$$' : '$'
    formula.replaceWith(tex ? delimiter + tex + delimiter : formula.textContent || '')
  }
  for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n')
  for (const paragraph of fragment.querySelectorAll('p,li,pre,blockquote,tr,h3,h4,h5,h6')) paragraph.append('\n')
  return (fragment.textContent || '').trim()
}
