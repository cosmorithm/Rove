import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'

export const pdfScheme = 'zhixu-pdf'

export async function importPdf(path: string, directory: string) {
  const source = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await source.stat()).isFile()) throw new Error('请选择 PDF 文件。')
    const header = Buffer.alloc(1024)
    const { bytesRead } = await source.read(header, 0, header.length, 0)
    const prefix = header.subarray(0, bytesRead)
    if (!prefix.includes('%PDF-')) throw new Error('文件缺少 PDF 标识，请检查所选文件。')

    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    const output = await open(temporary, 'wx', 0o600)
    try {
      const hash = createHash('sha256')
      try {
        hash.update(prefix)
        await output.writeFile(prefix)
        for await (const chunk of source.createReadStream({ start: bytesRead })) {
          hash.update(chunk)
          await output.writeFile(chunk)
        }
      } finally {
        await output.close()
      }
      const pdfId = hash.digest('hex')
      // Two concurrent imports with the same hash have identical content.
      await rename(temporary, join(directory, `${pdfId}.pdf`))
      return { name: basename(path), pdfId }
    } finally {
      await rm(temporary, { force: true })
    }
  } finally {
    await source.close()
  }
}

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return start <= end && start < size ? { start, end } : null
}

export async function servePdf(request: Request, directory: string, readerUrl: string): Promise<Response> {
  const reader = new URL(readerUrl)
  const origin = request.headers.get('Origin')
  if (origin && origin !== reader.origin && !(reader.protocol === 'file:' && origin === 'file://')) {
    return new Response(null, { status: 403 })
  }
  const headers = new Headers({
    'Access-Control-Allow-Origin': origin || reader.origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    'Vary': 'Origin',
  })
  const url = new URL(request.url)
  const id = /^\/([a-f0-9]{64})$/.exec(url.pathname)?.[1]
  if (!id || url.protocol !== pdfScheme + ':' || url.host !== 'library' ||
      url.username || url.password || url.search || url.hash) {
    return new Response(null, { status: 404, headers })
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    headers.set('Allow', 'GET, HEAD, OPTIONS')
    return new Response(null, { status: 405, headers })
  }

  let file
  try {
    file = await open(join(directory, `${id}.pdf`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile()) return new Response(null, { status: 404, headers })
    const size = stat.size
    const rangeHeader = request.headers.get('Range')
    const range = rangeHeader === null ? null : byteRange(rangeHeader, size)
    headers.set('Accept-Ranges', 'bytes')
    if (rangeHeader !== null && !range) {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Type', 'application/pdf')
    headers.set('Content-Length', String(range ? range.end - range.start + 1 : size))
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    const status = range ? 206 : 200
    if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers })

    const stream = file.createReadStream({ ...range, signal: request.signal })
    file = undefined // The stream closes its descriptor on completion, cancellation, or error.
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: stream.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
    })
    return new Response(body as ReadableStream<Uint8Array>, { status, headers })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return new Response(null, { status: code === 'ENOENT' || code === 'ELOOP' ? 404 : 500, headers })
  } finally {
    await file?.close()
  }
}
