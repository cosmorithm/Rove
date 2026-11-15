import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { StudyContextStore } from './studyContextStore'
import { createStudySummarizer } from './studySummary'
import type { PrepareStudyContextRequest, StudyTurnSource } from '../../src/studyContextTypes'

type Options = {
  ipcMain: IpcMain
  requireReader(event: IpcMainInvokeEvent): void
  storageDir: string
  readConfig: Parameters<typeof createStudySummarizer>[0]['readConfig']
}

export function registerStudyContext(options: Options) {
  const store = new StudyContextStore(join(options.storageDir, 'study-context'),
    createStudySummarizer({ readConfig: options.readConfig }))
  const handle = (name: string, action: (value: unknown) => unknown) => {
    options.ipcMain.handle('study-context:' + name, (event, value) => {
      options.requireReader(event)
      return action(value)
    })
  }
  // The store validates structured input and keeps all paths below its private directory.
  handle('get', value => store.get(value as string))
  handle('save', value => store.save(value as StudyTurnSource))
  handle('prepare', value => store.prepare(value as PrepareStudyContextRequest))
}
