import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodingStore } from '../codingCore.ts'

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trimEnd()
}
async function fixture(t) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'rove-import-')))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'Test Coding')
  await mkdir(root)
  return { root, tmp, store: new CodingStore(join(tmp, 'app', 'coding')) }
}
function author(root) {
  git(root, 'config', 'user.name', 'cosmorithm')
  git(root, 'config', 'user.email', 'cosmorithm@localhost')
}

test('opening a new folder creates main once; empty repos can bind a first turn and fork', async t => {
  const { root, tmp, store } = await fixture(t)
  const [a,b] = await Promise.all([store.importProject(root), store.importProject(root)])
  assert.equal(a.id, b.id)
  assert.equal(a.workspaces.length, 1)
  assert.equal((await store.listProjects()).length, 1)
  assert.equal((await new CodingStore(join(tmp, 'app', 'coding')).listProjects())[0].id, a.id)
  assert.equal(git(root, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  const workspace = a.workspaces[0]
  assert.equal((await store.status(workspace.id)).head, '')
  author(root)
  const before = await store.snapshot(workspace, 'before')
  const after = await store.turn(workspace, before, {
    runId: 'one', nodeId: 'turn-1', kind: 'ask', before,
    prompt: 'why', context: '', answer: 'ok', outcome: 'completed'
  })
  assert.equal(git(root, 'rev-parse', after+'^'), before)
  assert.equal(git(root, 'show', '-s', '--format=%an|%cn', after), 'cosmorithm|cosmorithm')
  assert.equal(git(root, 'rev-parse', '--revs-only', 'HEAD'), '')
  await assert.rejects(lstat(join(root, '.git/index')), { code: 'ENOENT' })
  const other = await store.fork(workspace.id, after, 'experiment')
  assert.equal(git(other.path, 'rev-parse', 'HEAD'), after)
  assert.notEqual(other.path, root)
})

test('a nested selection opens the existing worktree root and preserves HEAD and staged contents', async t => {
  const { root, store } = await fixture(t)
  git(root, 'init', '-q', '--initial-branch=existing')
  author(root)
  await writeFile(join(root, 'code'), 'base')
  git(root, 'add', 'code')
  git(root, 'commit', '-qm', 'first commit')
  await writeFile(join(root, 'code'), 'staged')
  git(root, 'add', 'code')
  await writeFile(join(root, 'code'), 'working')
  const head = git(root, 'rev-parse', 'HEAD')
  const index = await readFile(join(root, '.git/index'))
  const child = join(root, 'src', 'sub')
  await mkdir(child, { recursive: true })
  const project = await store.importProject(child)
  assert.equal(project.root, root)
  assert.equal(project.workspaces[0].branch, 'existing')
  assert.equal((await store.importProject(root)).id, project.id)
  assert.deepEqual(await readFile(join(root, '.git/index')), index)
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  await assert.rejects(lstat(join(child, '.git')), { code: 'ENOENT' })
  const malformed = join(root, 'bad')
  await mkdir(join(malformed, '.git'), { recursive: true })
  await assert.rejects(store.importProject(malformed), /\.git/)
})

test('broken and bare repositories are never reinitialized', async t => {
  const { root, tmp, store } = await fixture(t)
  await writeFile(join(root, '.git'), 'gitdir: /no/such/gitdir\n')
  await assert.rejects(store.importProject(root))
  assert.equal(await readFile(join(root, '.git'), 'utf8'), 'gitdir: /no/such/gitdir\n')
  const bare = join(tmp, 'project.git')
  git(tmp, 'init', '-q', '--bare', bare)
  await assert.rejects(store.importProject(bare))
  await assert.rejects(lstat(join(bare, '.git')), { code: 'ENOENT' })
  assert.deepEqual(await store.listProjects(), [])
})

test('a permission failure cannot turn a damaged checkout into a new repository', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses directory permissions')
  const { root, store } = await fixture(t)
  const marker = join(root, '.git')
  await mkdir(marker)
  await writeFile(join(marker, 'preserve-me'), 'yes')
  await chmod(marker, 0)
  try { await assert.rejects(store.importProject(root)) }
  finally { await chmod(marker, 0o700) }
  assert.deepEqual(await readdir(marker), ['preserve-me'])
})
