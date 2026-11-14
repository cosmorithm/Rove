import { PDFDataRangeTransport } from 'pdfjs-dist'

export type PdfSource = { url: string } | { data: string }
const chunkSize = 256 * 1024

async function readRange(url: string, begin: number, end: number, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal })
  if (response.status !== 206) {
    await response.body?.cancel()
    throw new Error(`读取 PDF 片段失败（${response.status}）`)
  }
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('Content-Range') || '')
  const length = Number(range?.[3])
  const actualEnd = Math.min(end, length)
  if (!range || !Number.isSafeInteger(length) || Number(range[1]) !== begin ||
      Number(range[2]) !== actualEnd - 1 || actualEnd <= begin) {
    await response.body?.cancel()
    throw new Error('PDF 片段的范围无效。')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== actualEnd - begin) throw new Error('PDF 片段不完整。')
  return { length, bytes }
}

// PDF.js only automatically enables Range for HTTP(S). The library URL is local to Electron.
class LibraryRangeTransport extends PDFDataRangeTransport {
  constructor(length: number, first: Uint8Array, private url: string, private controller: AbortController) {
    super(length, first)
  }

  requestDataRange(begin: number, end: number) {
    const { signal } = this.controller
    void readRange(this.url, begin, end, signal).then(({ bytes, length }) => {
      if (length !== this.length) throw new Error('PDF 大小发生变化，请重新导入。')
      if (!signal.aborted) this.onDataRange(begin, bytes)
    }).catch(reason => this.controller.abort(reason))
  }

  abort() {
    this.controller.abort()
  }
}

export async function pdfDocumentSource(source: PdfSource, controller: AbortController) {
  if ('data' in source) {
    const base64 = source.data.slice(source.data.indexOf(',') + 1)
    const binary = atob(base64)
    const data = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
    return { data }
  }
  const { length, bytes } = await readRange(source.url, 0, chunkSize, controller.signal)
  if (length === bytes.length) return { data: bytes }
  return {
    range: new LibraryRangeTransport(length, bytes, source.url, controller),
    rangeChunkSize: chunkSize,
    disableAutoFetch: true,
    disableStream: true
  }
}
