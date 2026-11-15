import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudyContextStore } from '../studyContextStore.ts'

const doc = { id: 'document-1', name: 'Stochastic processes', blockId: 'chapter-1', title: 'Markov chains' }
const turn = (nodeId, parentId, extra = {}) => ({
  nodeId, ...(parentId ? { parentId } : {}), question: nodeId + ' QUESTION', answer: nodeId + ' ANSWER',
  answerVersion: 'original', excerpt: nodeId + ' QUOTE', page: 2, document: { ...doc }, outcome: 'completed', ...extra,
})
const A = turn('A'), B = turn('B', 'A'), D = turn('D', 'B')
const request = (nodeId, depth = 3, level = 'L1', extra = {}) => ({
  nodeId, documentId: doc.id, question: 'Current question', ancestors: [D, B, A],
  selection: { depth, level }, materials: 'MATERIAL_SENTINEL', ...extra,
})
async function fixture(t, summarize) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rove-study-meta-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  const service = summarize ?? (async source => ({ L0: source.nodeId + '_L0', L1: source.nodeId + '_L1', L2: source.nodeId + '_L2', model: 'fixture-model' }))
  const generator = async source => { calls.push(source); return service(source) }
  const store = new StudyContextStore(directory, generator)
  return { directory, calls, store, generator }
}

test('selected levels inherit leaf-to-root, depth zero uses no ancestor, and requests are persisted', async t => {
  const f = await fixture(t)
  const all = await f.store.prepare(request('child-all'))
  assert.deepEqual(all.entries.map(e => e.nodeId), ['D', 'B', 'A'])
  assert.ok(all.context.indexOf('D_L1') < all.context.indexOf('B_L1'))
  assert.ok(all.context.indexOf('B_L1') < all.context.indexOf('A_L1'))
  assert.ok(all.context.indexOf('A_L1') < all.context.indexOf('MATERIAL_SENTINEL'))
  assert.ok(!all.context.includes('C_'), 'siblings are absent from the explicit path')
  assert.equal(all.nodeId, 'child-all')
  assert.equal(all.documentId, doc.id)
  assert.equal(all.question, 'Current question')
  assert.equal(all.truncated, false)
  assert.equal(all.used, all.context.length)
  const own = await f.store.get('child-all')
  assert.equal(own.parentId, 'D')
  assert.deepEqual(own.request, all)
  assert.equal(own.requestInput.question, 'Current question')

  const one = await f.store.prepare(request('child-one', 1, 'L2'))
  assert.deepEqual(one.entries.map(e => e.nodeId), ['D'])
  assert.ok(one.context.includes('D_L2') && !one.context.includes('D_L1'))
  assert.equal(f.calls.length, 3, 'each source is summarized once for all three levels')
  const zero = await f.store.prepare(request('child-zero', 0))
  assert.deepEqual(zero.entries, [])
  assert.ok(zero.context.includes('MATERIAL_SENTINEL'))
  assert.ok(!zero.context.includes('D_L1'))
  assert.equal(f.calls.length, 3)
  const file = (await readdir(f.directory))[0]
  assert.match(file, /^[a-f0-9]{64}\.json$/)
  assert.equal((await stat(join(f.directory, file))).mode & 0o777, 0o600)
})

test('context clipping gives the nearest ancestor priority and never generates omitted caches', async t => {
  const f = await fixture(t, async source => ({ L0: source.nodeId + '_L0', L1: source.nodeId + '_L1', L2: source.nodeId + '_L2-' + 'z'.repeat(500) }))
  const short = await f.store.prepare(request('clipped', 3, 'L2', { limit: 190 }))
  assert.equal(short.truncated, true)
  assert.equal(short.used, 190)
  assert.deepEqual(short.entries.map(e => e.nodeId), ['D'])
  assert.equal(short.entries[0].truncated, true)
  assert.equal(short.entries[0].includedChars, 190)
  assert.deepEqual(short.omittedNodeIds, ['B', 'A'])
  assert.ok(short.context.includes('D_L2-'))
  assert.equal(short.context.includes('MATERIAL_SENTINEL'), false)
  assert.equal(short.materialsIncludedChars, 0)
  assert.deepEqual(f.calls.map(s => s.nodeId), ['D'])
  assert.equal(await f.store.get('A'), null)
  assert.equal(await f.store.get('B'), null)
  const repeated = await f.store.prepare(request('clipped-again', 3, 'L2', { limit: 190 }))
  assert.equal(repeated.context, short.context)
  assert.equal(f.calls.length, 1)
})

test('Unicode clipping does not cut surrogate pairs or fill a partial ancestor with later material', async t => {
  const f = await fixture(t, async () => ({ L0: 'Unicode title', L1: '💖'.repeat(100), L2: 'Full summary' }))
  const full = await f.store.prepare(request('unicode-full', 1, 'L1', { materials: '' }))
  const header = full.context.indexOf('💖')
  const clipped = await f.store.prepare(request('unicode-clipped', 1, 'L1', { limit: header + 1 }))
  assert.equal(clipped.context.length, header)
  assert.equal(clipped.context, full.context.slice(0, header))
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.materialsIncludedChars, 0)
  assert.equal(/[\uD800-\uDBFF]$/.test(clipped.context), false)
})

test('all three caches survive restart, source edits add revisions, and snapshot requests survive saving the answer', async t => {
  const f = await fixture(t)
  const initial = await f.store.save(D)
  const first = initial.versions[0]
  assert.equal(first.state, 'ready')
  assert.equal(first.summaries.L0.text, 'D_L0')
  assert.equal(first.summaries.L1.text, 'D_L1')
  assert.equal(first.summaries.L2.text, 'D_L2')
  assert.equal(f.calls.length, 1)
  const reversed = { document: { title: doc.title, blockId: doc.blockId, name: doc.name, id: doc.id }, ...D }
  const reused = await new StudyContextStore(f.directory, f.generator).save(reversed)
  assert.equal(reused.versions[0].revision, first.revision)
  assert.equal(f.calls.length, 1)
  const edited = await f.store.save({ ...D, answer: 'EDITED ANSWER', answerVersion: 'edited' })
  assert.equal(edited.versions.length, 2)
  assert.equal(edited.versions[0].source.answer, 'D ANSWER')
  assert.equal(edited.versions[1].source.answer, 'EDITED ANSWER')
  assert.notEqual(edited.versions[0].revision, edited.versions[1].revision)
  assert.equal(f.calls.length, 2)

  const prepared = await f.store.prepare(request('child-save', 1))
  const saved = await f.store.save(turn('child-save', undefined))
  assert.equal(saved.parentId, 'D', 'the prepared parent is filled into the version')
  assert.equal(saved.versions[0].source.parentId, 'D')
  assert.equal(saved.request.context, prepared.context)
  const restarted = new StudyContextStore(f.directory, f.generator)
  const loaded = await restarted.get('child-save')
  assert.equal(loaded.versions[0].revision, saved.versions[0].revision, 'parent fill keeps the canonical revision stable')
  await restarted.save(turn('child-save', undefined))
  assert.equal((await restarted.get('child-save')).versions.length, 1)
})

test('in-flight source saves are durable, concurrent generation is deduplicated, and failures can retry', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let fail = false
  const f = await fixture(t, async source => {
    await gate
    if (fail) throw new Error('Summary provider unavailable')
    return { L0: source.nodeId + '_L0', L1: source.nodeId + '_L1', L2: source.nodeId + '_L2', inputTruncated: true, outputTruncated: true }
  })
  const promises = Array.from({ length: 8 }, () => f.store.save(D))
  while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 5))
  const pending = await f.store.get('D')
  assert.equal(pending.versions[0].state, 'pending')
  assert.equal(pending.versions[0].source.answer, 'D ANSWER')
  release()
  const results = await Promise.all(promises)
  assert.equal(f.calls.length, 1)
  assert.ok(results.every(m => m.versions.length === 1 && m.versions[0].state === 'ready'))
  assert.equal(results[0].versions[0].summaries.L1.inputTruncated, true)
  assert.equal(results[0].versions[0].summaries.L2.outputTruncated, true)
  fail = true
  const failed = await f.store.save(A)
  assert.equal(failed.versions[0].state, 'failed')
  assert.equal(failed.versions[0].source.answer, A.answer)
  assert.match(failed.versions[0].error, /unavailable/)
  await assert.rejects(f.store.prepare(request('prepare-failed', 1, 'L1', { ancestors: [A] })), /摘要尚未生成/)
  const failedRequest = await f.store.get('prepare-failed')
  assert.equal(failedRequest.requestInput.ancestorNodeIds[0], 'A')
  assert.match(failedRequest.requestError, /unavailable/)
  assert.equal(failedRequest.request, undefined)
  fail = false
  const retried = await f.store.prepare(request('prepare-failed', 1, 'L1', { ancestors: [A] }))
  assert.ok(retried.context.includes('A_L1'))
  assert.equal((await f.store.get('prepare-failed')).requestError, undefined)
})

test('invalid paths, invalid ancestor chains, other documents and oversized questions are rejected', async t => {
  const f = await fixture(t)
  await assert.rejects(f.store.get('../outside'), /无效/)
  await assert.rejects(f.store.prepare(request('bad-depth', 101)), /回溯/)
  await assert.rejects(f.store.prepare(request('bad-level', 1, 'L3')), /摘要/)
  await assert.rejects(f.store.prepare(request('bad-limit', 1, 'L1', { limit: 24_001 })), /长度/)
  await assert.rejects(f.store.prepare(request('long-question', 1, 'L1', { question: 'q'.repeat(4001) })), /问题/)
  await assert.rejects(f.store.prepare(request('cycle', 2, 'L1', { ancestors: [D, D] })), /重复|父节点/)
  await assert.rejects(f.store.prepare(request('sibling', 2, 'L1', { ancestors: [D, turn('C', 'A')] })), /父节点/)
  await assert.rejects(f.store.prepare(request('other-doc', 1, 'L1', { ancestors: [turn('other', undefined, { document: { ...doc, id: 'elsewhere' } })] })), /资料/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await readdir(f.directory), [])
})

test('L0 context inherits only the selected ancestor titles and reuses the same cached revisions', async t => {
  const f = await fixture(t)
  const selected = await f.store.prepare(request('title-child', 2, 'L0'))
  assert.deepEqual(selected.entries.map(entry => [entry.nodeId, entry.level, entry.text]),
    [['D', 'L0', 'D_L0'], ['B', 'L0', 'B_L0']])
  assert.ok(selected.context.indexOf('D_L0') < selected.context.indexOf('B_L0'))
  assert.ok(!selected.context.includes('_L1') && !selected.context.includes('_L2'))
  assert.ok(!selected.context.includes('D QUESTION') && !selected.context.includes('D ANSWER'))
  assert.equal((await f.store.get('title-child')).request.selection.level, 'L0')
  await f.store.prepare(request('detail-child', 2, 'L2'))
  assert.equal(f.calls.length, 2)
})

test('titles stay bound to source revisions and store limits cannot split Unicode', async t => {
  const f = await fixture(t, async source => ({
    L0: source.answerVersion === 'edited' ? '修订后的条件期望' : '题'.repeat(31) + '😀超长',
    L1: 'Short summary', L2: 'Detailed summary',
  }))
  const original = await f.store.save(D)
  assert.equal(original.versions[0].summaries.L0.text, '题'.repeat(31))
  assert.equal(original.versions[0].summaries.L0.outputTruncated, true)
  const edited = await f.store.save({ ...D, answerVersion: 'edited', answer: 'Revised answer' })
  assert.equal(edited.versions.length, 2)
  assert.equal(edited.versions[0].summaries.L0.text, '题'.repeat(31))
  assert.equal(edited.versions[1].summaries.L0.text, '修订后的条件期望')
  assert.notEqual(edited.versions[0].revision, edited.versions[1].revision)
  const restarted = await new StudyContextStore(f.directory, f.generator).get('D')
  assert.deepEqual(restarted.versions, edited.versions)
})

test('legacy L1/L2 caches can backfill L0 without changing revisions or existing summaries', async t => {
  const f = await fixture(t)
  const initial = await f.store.save(D)
  const path = join(f.directory, (await readdir(f.directory))[0])
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  delete legacy.versions[0].summaries.L0
  await writeFile(path, JSON.stringify(legacy))
  const retained = structuredClone(legacy.versions[0])
  const restarted = new StudyContextStore(f.directory, async () => ({
    L0: '补齐的自动标题', L1: 'Replacement must not overwrite L1', L2: 'Replacement must not overwrite L2',
  }))
  const loaded = await restarted.get('D')
  assert.equal(loaded.versions[0].state, 'ready')
  assert.equal(loaded.versions[0].summaries.L0, undefined)
  const backfilled = await restarted.save(D)
  assert.equal(backfilled.versions.length, 1)
  assert.equal(backfilled.versions[0].revision, initial.versions[0].revision)
  assert.deepEqual(backfilled.versions[0].source, retained.source)
  assert.equal(backfilled.versions[0].summaries.L0.text, '补齐的自动标题')
  assert.deepEqual(backfilled.versions[0].summaries.L1, retained.summaries.L1)
  assert.deepEqual(backfilled.versions[0].summaries.L2, retained.summaries.L2)
})

test('pending or failed legacy title backfill leaves cached L1/L2 usable and can retry L0', async t => {
  const f = await fixture(t)
  await f.store.save(D)
  const path = join(f.directory, (await readdir(f.directory))[0])
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  delete legacy.versions[0].summaries.L0
  await writeFile(path, JSON.stringify(legacy))
  let release, calls = 0, fail = true
  const gate = new Promise(resolve => { release = resolve })
  const restarted = new StudyContextStore(f.directory, async () => {
    calls++
    await gate
    if (fail) throw new Error('L0 backfill unavailable')
    return { L0: '重试生成的标题', L1: 'New short summary', L2: 'New detailed summary' }
  })
  const requests = Array.from({ length: 8 }, () => restarted.save(D))
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5))
  const pending = await restarted.get('D')
  assert.equal(pending.versions[0].state, 'pending')
  assert.deepEqual(pending.versions[0].summaries, legacy.versions[0].summaries)
  const during = await restarted.prepare(request('during-backfill', 1, 'L2'))
  assert.equal(during.entries[0].text, 'D_L2')
  assert.equal(calls, 1)
  release()
  const results = await Promise.all(requests)
  assert.equal(calls, 1, 'parallel backfill is deduplicated')
  assert.ok(results.every(result => result.versions[0].state === 'failed'))
  const failed = await restarted.get('D')
  assert.deepEqual(failed.versions[0].summaries, legacy.versions[0].summaries)
  assert.equal(failed.versions[0].revision, legacy.versions[0].revision)
  assert.deepEqual(failed.versions[0].source, legacy.versions[0].source)
  const after = await restarted.prepare(request('after-backfill', 1, 'L1'))
  assert.equal(after.entries[0].text, 'D_L1')
  assert.equal(calls, 1, 'using an existing selected cache never retries unrelated levels')
  await assert.rejects(restarted.prepare(request('missing-title', 1, 'L0')), /L0 摘要尚未生成.*backfill/)
  assert.equal(calls, 2)
  fail = false
  const retried = await restarted.prepare(request('retry-title', 1, 'L0'))
  assert.equal(retried.entries[0].text, '重试生成的标题')
  const ready = await restarted.get('D')
  assert.equal(ready.versions[0].state, 'ready')
  assert.equal(ready.versions.length, 1)
  assert.deepEqual(ready.versions[0].summaries.L1, legacy.versions[0].summaries.L1)
  assert.deepEqual(ready.versions[0].summaries.L2, legacy.versions[0].summaries.L2)
})
