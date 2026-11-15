import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodingTraceStore, traceKey } from '../codingTrace.ts'
import { CodingStore } from '../codingCore.ts'

const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trimEnd()
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rove-trace-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const coding = join(root, 'app', 'coding')
  return { root, coding, traces: new CodingTraceStore(coding) }
}

test('journal appends are durable FIFO, paginated, private, and recover across attempts', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.traces.read('missing'), { records: [], next: 0, done: true, available: false })
  const writer = await f.traces.start({ runId: 'attempt-1', nodeId: 'node-one' })
  const mutable = { type: 'tool_call', input: { text: '选中的原始参数' } }
  const first = writer.append(mutable)
  mutable.input.text = 'later mutation'
  const pending = [first, ...Array.from({ length: 19 }, (_, i) => writer.append({ type: 'tool_result', index: i + 1 }))]
  const written = await Promise.all(pending)
  assert.deepEqual(written.map(e => e.seq), Array.from({ length: 20 }, (_, i) => i + 1))
  const firstPage = await f.traces.read('node-one', 0, 3)
  assert.equal(firstPage.records[0].event.input.text, '选中的原始参数')
  assert.equal(firstPage.records.length, 3)
  assert.equal(firstPage.next, 3)
  assert.equal(firstPage.done, false)
  assert.equal(firstPage.available, true)
  const finalPage = await f.traces.read('node-one', 18, 3)
  assert.deepEqual(finalPage.records.map(r => r.seq), [19, 20])
  assert.equal(finalPage.done, true)
  assert.equal(finalPage.complete, false)
  const closed = await writer.close()
  assert.equal((await stat(closed.path)).mode & 0o777, 0o600)
  assert.equal(closed.events, 20)
  const bytes = await readFile(closed.path)
  assert.equal(closed.bytes, bytes.length)
  assert.equal(closed.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(await writer.close(), closed)
  await assert.rejects(writer.append({ type: 'late' }), /关闭/)

  const next = await new CodingTraceStore(f.coding).start({ runId: 'attempt-2', nodeId: 'node-one' })
  assert.equal((await next.append({ type: 'run_started' })).seq, 21)
  const finish = next.append({ type: 'run_finished', outcome: 'completed' })
  const closing = next.close()
  assert.equal((await finish).seq, 22)
  const recovered = await closing
  assert.equal(recovered.events, 22)
  assert.equal(recovered.runId, 'attempt-2')
  const page = await f.traces.read('node-one', 19)
  assert.deepEqual(page.records.map(r => r.runId), ['attempt-1', 'attempt-2', 'attempt-2'])
  assert.equal(page.complete, true)
  await assert.rejects(f.traces.read('../escape'), /无效/)
  await assert.rejects(f.traces.read('node-one', -1), /分页/)
  await assert.rejects(f.traces.read('node-one', 0, 201), /分页/)
})

test('locked or damaged journals never lose data; dead-process locks can recover', async t => {
  const f = await fixture(t)
  const writer = await f.traces.start({ runId: 'one', nodeId: 'locked-node' })
  await writer.append({ type: 'tool_call', tool: 'write_file' })
  await assert.rejects(new CodingTraceStore(f.coding).start({ runId: 'two', nodeId: 'locked-node' }), /仍在写入/)
  const closed = await writer.close()
  await appendFile(closed.path, '{"torn":')
  const damaged = await readFile(closed.path)
  await assert.rejects(f.traces.start({ runId: 'three', nodeId: 'locked-node' }), /末尾未写完/)
  await assert.rejects(f.traces.read('locked-node'), /末尾未写完/)
  assert.deepEqual(await readFile(closed.path), damaged)
  await assert.rejects(lstat(closed.path + '.lock'), { code: 'ENOENT' })

  const deadPid = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim())
  const deadPath = join(f.coding, 'runs', traceKey('dead-node') + '.jsonl')
  await writeFile(deadPath + '.lock', JSON.stringify({ pid: deadPid, token: 'stale-lock' }), { mode: 0o600 })
  const recovered = await f.traces.start({ runId: 'recovered', nodeId: 'dead-node' })
  await recovered.append({ type: 'run_finished' })
  await recovered.close()
  assert.equal((await f.traces.read('dead-node')).complete, true)

  const outside = join(f.root, 'user-file')
  await writeFile(outside, 'preserve user contents')
  const linked = join(f.coding, 'runs', traceKey('linked') + '.jsonl')
  await symlink(outside, linked)
  await assert.rejects(f.traces.start({ runId: 'no-follow', nodeId: 'linked' }))
  assert.equal(await readFile(outside, 'utf8'), 'preserve user contents')
})

test('live incomplete tails are flagged, and an append failure can close a valid durable prefix', async t => {
  const f = await fixture(t)
  const broken = await f.traces.start({ runId: 'live', nodeId: 'live-tail' })
  await broken.append({ type: 'run_started' })
  const path = join(f.coding, 'runs', traceKey('live-tail') + '.jsonl')
  await appendFile(path, '{"partial":')
  const live = await f.traces.read('live-tail')
  assert.equal(live.available, true)
  assert.equal(live.records.length, 1)
  assert.equal(live.done, false)
  await assert.rejects(broken.close(), /末尾未写完/)
  assert.ok((await readFile(path, 'utf8')).endsWith('{"partial":'))

  const writer = await f.traces.start({ runId: 'failed', nodeId: 'valid-prefix' })
  const queuedFirst = writer.append({ type: 'run_started' })
  const rejectedSecond = assert.rejects(writer.append({ type: 'bad-event', unsupported: 1n }))
  await queuedFirst
  await rejectedSecond
  await assert.rejects(writer.append({ type: 'must-not-silently-disappear' }))
  const partial = await writer.close()
  assert.equal(partial.events, 1)
  assert.equal((await f.traces.read('valid-prefix')).records[0].event.type, 'run_started')
})

test('Git retains one immutable turn plus pinned trace blob and supports large paged replay', async t => {
  const f = await fixture(t)
  const projectRoot = join(f.root, 'chosen project')
  await mkdir(projectRoot)
  git(projectRoot, 'init', '-q', '--initial-branch=main')
  git(projectRoot, 'config', 'user.name', 'cosmorithm')
  git(projectRoot, 'config', 'user.email', 'cosmorithm@localhost')
  await writeFile(join(projectRoot, 'code.js'), 'original\n')
  git(projectRoot, 'add', '.')
  git(projectRoot, 'commit', '-qm', 'user commit')
  const head = git(projectRoot, 'rev-parse', 'HEAD')
  await writeFile(join(projectRoot, 'code.js'), 'user staged\n')
  git(projectRoot, 'add', 'code.js')
  await writeFile(join(projectRoot, 'code.js'), 'user working\n')
  const index = await readFile(join(projectRoot, '.git/index'))
  const store = new CodingStore(f.coding)
  const project = await store.importProject(projectRoot), workspace = project.workspaces[0]
  const before = await store.snapshot(workspace, 'before')
  const writer = await f.traces.start({ runId: 'large-run', nodeId: 'large-node' })
  await writer.append({ type: 'run_started', workspaceId: workspace.id, before })
  await writer.append({ type: 'tool_call', tool: 'bash', input: { command: 'test' } })
  // More than the old 64 MiB execFile maxBuffer; each returned page remains small.
  const payload = '工具返回值🙂'.repeat(65536)
  for (let i = 0; i < 80; i++) await writer.append({ type: 'tool_result', index: i, result: payload })
  await writer.append({ type: 'run_finished', outcome: 'completed' })
  const summary = await writer.close()
  assert.ok(summary.bytes > 64 * 1024 * 1024)
  const info = await store.archiveTrace(workspace, 'large-node', summary)
  assert.equal(info.events, 83)
  assert.equal(info.sha256, summary.sha256)
  assert.equal(git(projectRoot, 'cat-file', '-t', info.blob), 'blob')
  assert.equal(git(projectRoot, 'rev-parse', 'refs/rove/traces/' + traceKey('large-node')), info.blob)
  info.partial = true
  const details = { runId: 'large-run', nodeId: 'large-node', kind: 'edit', before,
    prompt: 'implement', context: 'selected ancestry', answer: 'done', outcome: 'completed', trace: info }
  const after = await store.turn(workspace, before, details)
  assert.equal(git(projectRoot, 'rev-parse', after + '^'), before)
  assert.deepEqual(JSON.parse(git(projectRoot, 'show', '-s', '--format=%b', after)).trace, info)
  assert.deepEqual((await store.existingTurn(workspace, 'large-node')).trace, info)
  assert.equal(git(projectRoot, 'rev-parse', 'HEAD'), head)
  assert.deepEqual(await readFile(join(projectRoot, '.git/index')), index)
  assert.equal(await readFile(join(projectRoot, 'code.js'), 'utf8'), 'user working\n')

  git(projectRoot, 'gc', '--prune=now')
  await rm(summary.path)
  const reopened = new CodingStore(f.coding)
  let cursor = 0, total = 0
  do {
    const page = await reopened.readTrace(workspace.id, 'large-node', cursor, 7)
    assert.equal(page.complete, true)
    assert.equal(page.partial, true)
    assert.ok(page.records.length <= 7)
    for (const record of page.records) {
      assert.equal(record.seq, ++total)
      if (record.event.type === 'tool_result') assert.equal(record.event.result, payload)
    }
    cursor = page.next
    if (page.done) break
  } while (true)
  assert.equal(total, 83)
  assert.equal(git(projectRoot, 'cat-file', '-t', info.blob), 'blob')
  assert.equal(git(projectRoot, 'rev-parse', 'HEAD'), head)
  assert.deepEqual(await readFile(join(projectRoot, '.git/index')), index)

  const oldDetails = { ...details, nodeId: 'legacy-node', trace: undefined }
  await store.turn(workspace, after, oldDetails)
  assert.equal((await store.readTrace(workspace.id, 'legacy-node')).available, false)
  assert.equal((await store.readTrace(workspace.id, 'unknown-node')).available, false)
  await assert.rejects(store.readTrace(workspace.id, 'large-node', 0, 201), /分页/)
  const retry = await f.traces.start({ runId: 'attempt-after-bound', nodeId: 'large-node' })
  await retry.append({ type: 'new-data-after-binding' })
  const different = await retry.close()
  await assert.rejects(store.archiveTrace(workspace, 'large-node', different), /不能替换/)
  assert.equal(git(projectRoot, 'rev-parse', 'refs/rove/traces/' + traceKey('large-node')), info.blob)
  const unchanged = await new CodingStore(f.coding).readTrace(workspace.id, 'large-node', 82, 2)
  assert.equal(unchanged.records.length, 1)
  assert.equal(unchanged.records[0].event.type, 'run_finished')
})
