import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCheck, registerUpdateHandlers } from '../updateCheck.ts'

const sha = 'abcdef0123456789abcdef0123456789abcdef01'
const ahead = { status: 'ahead', ahead_by: 2, behind_by: 0 }
test('the fixed upstream main check is anonymous and shared by concurrent and later requests', async () => {
  let calls = 0
  const check = createUpdateCheck(sha, async (url, init) => {
    calls++
    assert.equal(url, 'https://api.github.com/repos/cosmorithm/Rove/compare/' + sha + '...main?per_page=1')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    assert.equal(new Headers(init.headers).has('authorization'), false)
    return Response.json(ahead)
  })
  const first = check()
  assert.equal(check(), first)
  assert.equal(await first, true)
  assert.equal(check(), first)
  assert.equal(calls, 1)
})

test('identical, behind, diverged and malformed comparisons cannot prompt an update', async () => {
  for (const data of [
    {status:'identical', ahead_by:0, behind_by:0}, {status:'behind', ahead_by:0, behind_by:2},
    {status:'diverged', ahead_by:3, behind_by:1}, {...ahead, behind_by:1}, {...ahead, ahead_by:0},
    {...ahead, ahead_by:'2'}, null,
  ]) {
    assert.equal(await createUpdateCheck(sha, async () => Response.json(data))(), false)
  }
})

test('missing build identity, failed requests and aborts are silent', async () => {
  let calls = 0
  const offline = async () => { calls++; throw new Error('offline') }
  for (const invalid of ['', 'main', '../main', 'a'.repeat(41)])
    assert.equal(await createUpdateCheck(invalid, offline)(), false)
  assert.equal(calls, 0)
  assert.equal(await createUpdateCheck(sha, offline)(), false)
  for (const response of [new Response('',{status:403}), new Response('',{status:404}), new Response('invalid')])
    assert.equal(await createUpdateCheck(sha, async () => response)(), false)
  let aborted = false
  const hung = (_url, {signal}) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout not reached')), 500)
    signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(signal.reason) }, {once:true})
  })
  assert.equal(await createUpdateCheck(sha, hung, 10)(), false)
  assert.equal(aborted, true)
})

test('both IPC actions require a trusted frame and no arguments; only the guide action opens the browser', async () => {
  const callbacks = new Map()
  const event = {}
  let checks = 0, opened = []
  registerUpdateHandlers({handle:(id,fn)=>callbacks.set(id,fn)}, incoming=>assert.equal(incoming,event),
    async()=>{ checks++; return true }, async url=>{ opened.push(url) })
  for (const callback of callbacks.values()) {
    assert.throws(() => callback({}))
    assert.throws(() => callback(event,'https://example.invalid'))
  }
  assert.equal(await callbacks.get('updates:check')(event),true)
  assert.deepEqual(opened,[])
  assert.equal(checks,1)
  await callbacks.get('updates:open-guide')(event)
  assert.deepEqual(opened,['https://github.com/cosmorithm/Rove#update-with-a-coding-agent'])
})
