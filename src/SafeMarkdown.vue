<script lang="ts">
import { defineComponent, h, onMounted, ref, watch, type VNodeChild } from 'vue'
import { Lexer, Marked, type MarkedToken, type Token } from 'marked'
import katex from 'katex'
import 'katex/dist/katex.min.css'

const MathFormula = defineComponent({
  props: { tex: { type: String, required: true }, display: Boolean, raw: { type: String, required: true } },
  setup(props) {
    const element = ref<HTMLElement>()
    function typeset() {
      if (!element.value) return
      const el = element.value
      try {
        if (props.tex.length > 12000) throw new Error('formula too long')
        katex.render(props.tex, el, {
          displayMode: props.display, trust: false, throwOnError: true,
          maxExpand: 500, maxSize: 20, strict: 'ignore', output: 'htmlAndMathml'
        })
        el.classList.remove('folio-math-verbatim')
        el.removeAttribute('title')
      } catch {
        el.textContent = props.raw
        el.classList.add('folio-math-verbatim')
        el.title = '公式保留为原始 LaTeX，请结合原文核对。'
      }
    }
    onMounted(typeset)
    watch(() => [props.tex, props.display], typeset, { flush: 'post' })
    return () => h('span', { ref: element, class: props.display ? 'folio-math-block' : 'folio-math-inline' })
  }
})

function readFormula(source: string) {
  const opening = source.match(/^(\\\[|\\\(|\$\$|\$)/)?.[0]
  if (!opening) return
  const display = opening === '\\[' || opening === '$$'
  if (opening === '$' && /^\s/.test(source.slice(1))) return
  const close = opening === '\\[' ? '\\]' : opening === '\\(' ? '\\)' : opening
  for (let i = opening.length; (i = source.indexOf(close, i)) >= 0; i += close.length) {
    let slashes = 0
    for (let p = i - 1; p >= 0 && source[p] === '\\'; p--) slashes++
    if (slashes % 2 || opening === '$' && /\s/.test(source[i - 1])) continue
    const tex = source.slice(opening.length, i)
    if (!tex.trim() || !display && /\n\s*\n/.test(tex)) return
    return { raw: source.slice(0, i + close.length), tex, display }
  }
}

const markdown = new Marked({ gfm: true }, { extensions: [
  {
    name: 'folioDisplay', level: 'block',
    start(source) { return source.match(/\n {0,3}(?:\\\[|\$\$)/)?.index },
    tokenizer(source) {
      const indent = source.match(/^ {0,3}/)![0]
      const formula = readFormula(source.slice(indent.length))
      if (!formula?.display) return
      const end = source.slice(indent.length + formula.raw.length).match(/^[ \t]*(?:\n|$)/)
      if (end) return { ...formula, type: 'folioDisplay', raw: indent + formula.raw + end[0] }
    }
  },
  {
    name: 'folioMath', level: 'inline',
    start(source) { return source.search(/\\[[(]|\$/) },
    tokenizer(source) {
      const formula = readFormula(source)
      if (formula) return { ...formula, type: 'folioMath' }
    }
  },
  {
    name: 'folioSource', level: 'inline',
    start(source) { return source.search(/第\s*\d+\s*(?:页|[–—~至-])/) },
    tokenizer(source) {
      const match = source.match(/^第\s*(\d+)\s*(?:[–—~至-]\s*(\d+)\s*)?页/)
      if (match) return { type: 'folioSource', raw: match[0], page: Number(match[1]), endPage: Number(match[2] || match[1]) }
    }
  }
] })

export default defineComponent({
  name: 'SafeMarkdown',
  props: { text: { type: String, default: '' }, inline: Boolean, pageCount: { type: Number, default: 0 } },
  emits: { source: (page: number) => Number.isInteger(page) && page > 0 },
  setup(props, { emit }) {
    function renderTokens(tokens: Token[]): VNodeChild[] {
      return tokens.map(renderToken)
    }
    function renderToken(token: Token): VNodeChild {
      if (token.type === 'folioMath' || token.type === 'folioDisplay') {
        return h(MathFormula, { raw: token.raw, tex: token.tex, display: token.display })
      }
      if (token.type === 'folioSource') {
        if (token.page < 1 || token.endPage < token.page || token.endPage > props.pageCount) return token.raw
        return h('button', {
          type: 'button', class: 'folio-source', title: '在 PDF 中查看原文',
          onClick: (event: Event) => { event.stopPropagation(); emit('source', token.page) }
        }, token.raw)
      }
      const t = token as MarkedToken
      switch (t.type) {
        case 'paragraph': return h('p', renderTokens(t.tokens))
        case 'heading': return h('h' + Math.min(t.depth + 2, 6), renderTokens(t.tokens))
        case 'blockquote': return h('blockquote', renderTokens(t.tokens))
        case 'hr': return h('hr')
        case 'br': return h('br')
        case 'strong': case 'em': case 'del': return h(t.type, renderTokens(t.tokens))
        case 'list': return h(t.ordered ? 'ol' : 'ul', t.ordered && t.start !== 1 ? { start: t.start } : {}, t.items.map(renderToken))
        case 'list_item': return h('li', [t.task ? (t.checked ? '☑ ' : '☐ ') : '', ...renderTokens(t.tokens)])
        case 'code': return h('pre', [h('code', t.text)])
        case 'codespan': return h('code', t.text)
        case 'text': return t.tokens ? renderTokens(t.tokens) : t.text
        case 'escape': return t.text
        case 'html': return t.raw
        case 'space': case 'def': return ''
        case 'link': return renderTokens(t.tokens)
        case 'image': return t.text || '图片'
        case 'table': {
          const row = (cells: typeof t.header, tag: string) => h('tr', cells.map(cell => h(tag, renderTokens(cell.tokens))))
          return h('div', { class: 'folio-table' }, [h('table', [
            h('thead', [row(t.header, 'th')]), h('tbody', t.rows.map(cells => row(cells, 'td')))
          ])])
        }
        default: return token.raw
      }
    }
    return () => {
      const lexer = new Lexer(markdown.defaults)
      const tokens = props.inline ? lexer.inlineTokens(props.text) : lexer.lex(props.text)
      return h(props.inline ? 'span' : 'div', { class: props.inline ? 'folio-markdown-inline' : 'folio-markdown' }, renderTokens(tokens))
    }
  }
})
</script>

<style>
.folio-markdown { overflow-wrap: anywhere; line-height: 1.75; white-space: normal; min-width: 0; }
.folio-markdown :where(p, pre, blockquote, ol, ul, .folio-table) { margin: .65em 0; }
.folio-markdown > :first-child { margin-top: 0; }
.folio-markdown > :last-child { margin-bottom: 0; }
.folio-markdown :where(h3,h4,h5,h6) { margin: 1.15em 0 .35em; font: inherit; font-weight: 650; }
.folio-markdown :where(ol,ul) { padding-inline-start: 1.65em; }
.folio-markdown li > p { margin: .25em 0; }
.folio-markdown blockquote { padding-inline-start: 1em; border-inline-start: 2px solid currentColor; }
.folio-markdown hr { margin: 1em 0; border: 0; border-top: 1px solid var(--rove-line); }
.folio-markdown code, .folio-math-verbatim { font: .91em ui-monospace, monospace; }
.folio-markdown pre, .folio-table, .folio-math-block { max-width: 100%; overflow-x: auto; }
.folio-markdown pre { padding: .65em .8em; background: var(--rove-rail); border-radius: 5px; white-space: pre; }
.folio-table table { border-collapse: collapse; }
.folio-table :is(td,th) { padding: .3em .65em; border: 1px solid var(--rove-line); text-align: start; }
.folio-math-block { display: block; padding: .1em 0; margin: .5em 0; overflow-y: hidden; }
.folio-math-block > .katex-display { margin: .25em 0; }
.folio-math-block .katex-display > .katex { text-align: left; }
.folio-math-inline .katex, .folio-math-block .katex { font-size: 1.08em; }
.folio-source { padding: 0 .14em; border: 0; font: inherit; color: var(--rove-accent-strong); background: transparent; text-decoration: underline; text-underline-offset: .15em; }
</style>
