import type { IpcMain, IpcMainInvokeEvent } from 'electron'

const guideUrl = 'https://github.com/cosmorithm/Rove#update-with-a-coding-agent'

/** Compare the built commit (base) with upstream main (head), once per app process. */
export function createUpdateCheck(buildCommit: string, request: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 5000) {
  let result: Promise<boolean> | undefined
  async function compare() {
    if (!/^[0-9a-f]{40}$/i.test(buildCommit)) return false
    try {
      const response = await request(
        'https://api.github.com/repos/cosmorithm/Rove/compare/' + buildCommit + '...main?per_page=1',
        { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/vnd.github+json' } },
      )
      if (!response.ok) return false
      const data = await response.json()
      return data?.status === 'ahead' && Number.isSafeInteger(data.ahead_by) && data.ahead_by > 0 && data.behind_by === 0
    } catch {
      // Offline, unknown commits and rate limits all leave startup undisturbed.
      return false
    }
  }
  return () => result ??= compare()
}

export function registerUpdateHandlers(ipc: Pick<IpcMain, 'handle'>, requireReader: (event: IpcMainInvokeEvent) => void,
  check: () => Promise<boolean>, openExternal: (url: string) => Promise<void>) {
  function validate(event: IpcMainInvokeEvent, args: unknown[]) {
    requireReader(event)
    if (args.length) throw new Error('此操作不接受参数。')
  }
  ipc.handle('updates:check', (event, ...args) => {
    validate(event, args)
    return check()
  })
  ipc.handle('updates:open-guide', (event, ...args) => {
    validate(event, args)
    return openExternal(guideUrl)
  })
}
