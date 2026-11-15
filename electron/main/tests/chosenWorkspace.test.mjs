import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { Module, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { CodingStore } from '../codingCore.ts'
import { CodingTraceStore } from '../codingTrace.ts'
import { sanitizeHarnessEvent } from '../codingEngine.ts'

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trimEnd()
}

// Run the actual IPC orchestration and Git store while replacing only Electron
// and the external model process. No network or real provider credentials are used.
async function registerFixture({ storageDir, envFile, action, dialogResult }) {
  const sourcePath = fileURLToPath(new URL('../coding.ts', import.meta.url))
  const compiled = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const require = createRequire(import.meta.url)
  const ipcHandlers = new Map(), calls = [], progress = [], dialogs = []
  const sender = new EventEmitter()
  sender.isDestroyed = () => false
  sender.send = (name, payload) => progress.push({ name, ...payload })
  const bridge = new Module(sourcePath)
  bridge.filename = sourcePath
  bridge.paths = Module._nodeModulePaths(dirname(sourcePath))
  bridge.require = name => {
    if (name === 'electron') return { dialog: { showOpenDialog: async (window, options) => {
      dialogs.push({ window, options })
      return dialogResult()
    } } }
    if (name === './codingCore') return { CodingStore }
    if (name === './codingTrace') return { CodingTraceStore }
    if (name === './codingEngine') return { sanitizeHarnessEvent, createHarnessEngine: () => ({
      engine: async () => ({ available: true, authenticated: true, version: 'mock', message: 'mock' }),
      runHarness: async options => {
        calls.push(options)
        return action(options)
      }
    }) }
    return require(name)
  }
  bridge._compile(compiled, sourcePath)
  const window = {}
  let authorized = 0
  bridge.exports.registerCoding({
    ipcMain: { handle: (name, handler) => ipcHandlers.set(name, handler) },
    window: () => window,
    requireReader: () => { authorized++ },
    storageDir, envFile, appRoot: dirname(sourcePath)
  })
  return {
    invoke: (name, value) => ipcHandlers.get('coding:' + name)({ sender }, value),
    calls, progress, dialogs, sender,
    authorized: () => authorized
  }
}

async function fixture(t) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'rove-chosen-')))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'Test Coding'), storageDir = join(tmp, 'app')
  await mkdir(root)
  git(root, 'init', '-q', '--initial-branch=main')
  git(root, 'config', 'user.name', 'cosmorithm')
  git(root, 'config', 'user.email', 'cosmorithm@localhost')
  await writeFile(join(root, 'staged.txt'), 'base staged\n')
  await writeFile(join(root, 'working.txt'), 'base working\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')
  const head = git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'staged.txt'), 'user staged\n')
  git(root, 'add', 'staged.txt')
  await writeFile(join(root, 'working.txt'), 'user dirty\n')
  await writeFile(join(root, 'loose.txt'), 'user untracked\n')
  const index = await readFile(join(root, '.git/index'))
  const store = new CodingStore(join(storageDir, 'coding'))
  const project = await store.importProject(root)
  return { tmp, root, storageDir, head, index, store, project, workspace: project.workspaces[0] }
}

function request(workspace, nodeId, kind = 'edit', parentCommit) {
  return { runId: 'run-' + nodeId, nodeId, workspaceId: workspace.id, kind,
    prompt: 'Make the requested artifact in the selected folder: ' + nodeId,
    context: '', parentCommit }
}
function record(root, sha) {
  return JSON.parse(git(root, 'show', '-s', '--format=%b', sha))
}

async function assertUserGitPreserved(f) {
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head)
  assert.deepEqual(await readFile(join(f.root, '.git/index')), f.index)
  assert.equal(await readFile(join(f.root, 'staged.txt'), 'utf8'), 'user staged\n')
  assert.equal(await readFile(join(f.root, 'working.txt'), 'utf8'), 'user dirty\n')
  assert.equal(await readFile(join(f.root, 'loose.txt'), 'utf8'), 'user untracked\n')
}

test('coding runs write into the selected project folder and retain unique immutable turn records', async t => {
  const f = await fixture(t)
  let behavior = async () => ({ answer: 'Read only answer', cancelled: false })
  const ipc = await registerFixture({ storageDir: f.storageDir, envFile: join(f.tmp, 'unused.env'),
    action: options => behavior(options), dialogResult: () => { throw new Error('No directory picker during a normal run') } })
  const first = await ipc.invoke('run', request(f.workspace, 'read-only', 'ask'))
  assert.equal(ipc.calls[0].cwd, f.root)
  assert.equal(first.status.workspace.id, f.workspace.id)
  assert.notEqual(first.after, first.before)
  assert.equal(git(f.root, 'rev-parse', first.after + '^'), first.before)
  await assertUserGitPreserved(f)

  behavior = async options => {
    assert.equal(options.cwd, f.root)
    await options.onEvent({type:'tool_call', callId:'write-index', tool:'write_file', input:{path:'index.html', content:'<!doctype html><title>Fireworks</title>\n'}})
    await writeFile(join(options.cwd, 'index.html'), '<!doctype html><title>Fireworks</title>\n')
    await options.onEvent({type:'tool_result', callId:'write-index', status:'completed', result:'Saved index.html'})
    options.onProgress('Wrote index.html')
    return { answer: 'index.html created', cancelled: false }
  }
  const editInput = request(f.workspace, 'implementation', 'edit', first.after)
  const edited = await ipc.invoke('run', editInput)
  assert.equal(edited.status.workspace.id, f.workspace.id)
  assert.equal(edited.status.workspace.path, f.root)
  assert.notEqual(edited.after, edited.before)
  assert.notEqual(edited.after, first.after)
  assert.equal(git(f.root, 'rev-parse', edited.after + '^'), first.after)
  assert.equal(git(f.root, 'show', edited.after + ':index.html'), '<!doctype html><title>Fireworks</title>')
  assert.equal(await readFile(join(f.root, 'index.html'), 'utf8'), '<!doctype html><title>Fireworks</title>\n')
  assert.equal(record(f.root, edited.after).workspaceId, f.workspace.id)
  assert.equal(record(f.root, edited.after).outcome, 'completed')
  assert.equal(record(f.root, edited.after).before, edited.before)
  assert.equal(edited.trace.format, 'jsonl-v1')
  assert.equal(record(f.root, edited.after).trace.blob, edited.trace.blob)
  const page = await ipc.invoke('trace', {workspaceId:f.workspace.id, nodeId:editInput.nodeId})
  assert.equal(page.complete, true)
  assert.equal(page.records[0].event.type, 'run_started')
  assert.equal(page.records.at(-1).event.type, 'run_finished')
  assert.equal(page.records.find(r=>r.event.type==='tool_call').event.input.path, 'index.html')
  assert.equal(page.records.find(r=>r.event.type==='tool_result').event.result, 'Saved index.html')
  assert.ok(ipc.progress.some(p=>p.record?.event.type==='tool_result'))
  assert.equal(git(f.root, 'cat-file', '-t', edited.trace.blob), 'blob')
  assert.equal(git(f.root, 'show', '-s', '--format=%an|%cn', edited.after), 'cosmorithm|cosmorithm')
  assert.equal((await ipc.invoke('list-projects'))[0].workspaces.length, 1)
  await assert.rejects(lstat(join(f.storageDir, 'coding/worktrees')), { code: 'ENOENT' })
  await assertUserGitPreserved(f)

  const calls = ipc.calls.length
  const replay = await ipc.invoke('run', { ...editInput, runId: 'replayed-run' })
  assert.equal(replay.after, edited.after)
  assert.equal(ipc.calls.length, calls, 'A bound node must not rerun the model')

  behavior = async options => {
    await writeFile(join(options.cwd, 'partial.txt'), 'partial artifact\n')
    throw new Error('model process failed')
  }
  const failed = await ipc.invoke('run', request(f.workspace, 'failed', 'edit', edited.after))
  assert.equal(record(f.root, failed.after).outcome, 'failed')
  assert.equal(git(f.root, 'show', failed.after + ':partial.txt'), 'partial artifact')
  assert.equal(failed.status.workspace.id, f.workspace.id)
  assert.equal(git(f.root, 'rev-parse', failed.after + '^'), edited.after)
  await assertUserGitPreserved(f)
  assert.equal(ipc.dialogs.length, 0)
  assert.ok(ipc.authorized() >= 5)
})

test('an explicitly selected branch folder stays selected; only an explicit fork opens a directory picker', async t => {
  const f = await fixture(t)
  const branchFolder = join(f.tmp, 'chosen branch')
  await mkdir(branchFolder)
  const selected = await f.store.fork(f.workspace.id, branchFolder, f.head, 'Selected branch')
  assert.equal(selected.isMain, false)
  let choice = { canceled: true, filePaths: [] }
  const ipc = await registerFixture({ storageDir: f.storageDir, envFile: join(f.tmp, 'unused.env'),
    dialogResult: () => choice,
    action: async options => {
      assert.equal(options.cwd, branchFolder)
      await writeFile(join(options.cwd, 'branch-only.txt'), 'selected branch artifact\n')
      return { answer: 'done', cancelled: false }
    } })
  const result = await ipc.invoke('run', request(selected, 'selected-branch'))
  assert.equal(result.status.workspace.id, selected.id)
  assert.equal(await readFile(join(branchFolder, 'branch-only.txt'), 'utf8'), 'selected branch artifact\n')
  await assert.rejects(lstat(join(f.root, 'branch-only.txt')), { code: 'ENOENT' })
  assert.equal(ipc.dialogs.length, 0)
  assert.equal((await ipc.invoke('list-projects'))[0].workspaces.length, 2)
  await assertUserGitPreserved(f)

  const cancelled = await ipc.invoke('fork', { workspaceId: selected.id, commit: result.after, label: 'cancelled' })
  assert.equal(cancelled, null)
  assert.equal((await ipc.invoke('list-projects'))[0].workspaces.length, 2)
  const destination = join(f.tmp, 'another chosen branch')
  await mkdir(destination)
  choice = { canceled: false, filePaths: [destination] }
  const fork = await ipc.invoke('fork', { workspaceId: selected.id, commit: result.after, label: 'Explicit branch' })
  assert.equal(fork.path, destination)
  assert.equal(git(destination, 'rev-parse', 'HEAD'), result.after)
  assert.equal((await ipc.invoke('list-projects'))[0].workspaces.length, 3)
  assert.equal(ipc.dialogs.length, 2)
  assert.ok(ipc.dialogs.every(call => call.options.properties.includes('openDirectory')))
})
