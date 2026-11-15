import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnessEngine, sanitizeHarnessEvent } from '../codingEngine.ts'

test('DSH uses private configuration, restricted permissions and terminal JSON events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rove-dsh-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const envFile = join(root, 'test.env')
  const service = createHarnessEngine({ appRoot: root, resourcesPath: join(root, 'resources'), storageDir: root, envFile })
  assert.equal((await service.engine()).available, false)
  const folder = join(root, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(folder, 'lib'), { recursive: true })
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'test', type: 'commonjs' }))
  await writeFile(join(folder, 'lib/bin.js'), `
    const assert = require('node:assert/strict')
    const fs = require('node:fs')
    ;(async () => {
      let task = ''
      for await (const chunk of process.stdin) task += chunk
      const args = process.argv.slice(2)
      assert.equal(args[0], 'headless')
      assert.deepEqual(args.slice(-4), ['--approval-policy', 'never', '--json', '-'])
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined)
      assert.ok(!process.env.OPENAI_API_KEY)
      const patch = fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8')
      assert.ok(!patch.includes(process.env.DEEPSEEK_API_KEY))
      assert.ok(patch.includes('model-for-test'))
      const emit = e => process.stdout.write(JSON.stringify(e) + '\\n')
      emit({type:'session'})
      emit({type:'status', phase:'step_start'})
      emit({type:'thinking', text:'private reasoning'})
      emit({type:'tool_call', tool:'read_file', input:'private command'})
      emit({type:'tool_result', status:'completed', result:'private content'})
      emit({type:'status', phase:'step_end'})
      emit({type:'status', phase:'step_start'})
      if (task === 'pause') { setInterval(() => {}, 50); return }
      if (task === 'error') {
        emit({type:'error', message:'service: '+process.env.DEEPSEEK_API_KEY})
        process.exitCode = 1
        return
      }
      if (task === 'invalid') { console.log('invalid JSON'); return }
      if (task === 'failed') { emit({type:'final', reason:{kind:'failed'}, text:'answer'}); return }
      assert.equal(task, '测试中文')
      emit({type:'final', reason:{kind:'completed'}, text:args[args.indexOf('--permission-mode')+1]+' '+process.env.DEEPSEEK_BASE_URL})
    })().catch(e => { console.error(e); process.exitCode = 2 })
  `)
  async function settings(content) {
    await writeFile(envFile, 'DEEPSEEK_API_KEY=\nDEEPSEEK_BASE_URL=\nDEEPSEEK_MODEL=model-for-test\n' + content)
  }
  await settings('OPENAI_API_KEY=unrelated\nOPENAI_BASE_URL=https://api.openai.com/v1')
  assert.equal((await service.engine()).authenticated, false)
  await settings('OPENAI_API_KEY=test-legacy-key\nOPENAI_BASE_URL=https://api.deepseek.com/v1\nDEEPSEEK_BASE_URL=http://localhost:32839')
  assert.equal((await service.engine()).authenticated, false)
  await settings('OPENAI_API_KEY=test-legacy-key\nOPENAI_BASE_URL=https://api.deepseek.com/v1')
  const messages = []
  const run = (prompt, extra = {}) => service.runHarness({
    cwd: root, prompt, kind: 'ask', signal: new AbortController().signal, onProgress: m => messages.push(m), ...extra
  })
  assert.equal((await run('测试中文')).answer, 'read-only https://api.deepseek.com/anthropic')
  await settings('DEEPSEEK_API_KEY=test-DSH-secret\nDEEPSEEK_BASE_URL=http://localhost:32839/anthropic')
  assert.equal((await run('测试中文', { kind: 'edit' })).answer, 'workspace-write http://localhost:32839/anthropic')
  assert.ok(messages.some(m => m.includes('read_file')))
  assert.ok(messages.some(m => m.includes('第 1 步')))
  assert.ok(messages.some(m => m.includes('第 2 步')))
  assert.ok(messages.every(m => !m.includes('private')))
  await assert.rejects(run('error'), e => e.message.includes('密钥已省略') && !e.message.includes('test-DSH-secret'))
  await assert.rejects(run('invalid'), /JSON/)
  await assert.rejects(run('failed'), /failed/)
  const controller = new AbortController()
  const stopped = await run('pause', { signal: controller.signal, onProgress: () => controller.abort() })
  assert.equal(stopped.cancelled, true)
  await assert.rejects(run('测试中文', { cwd: join(root, 'missing-dir') }), /ENOENT/)
  assert.deepEqual(await readdir(join(root, 'coding/dsh')), [])
})

test('Electron requires a standalone Node and uses bundled node/npm ahead of the system PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rove-dsh-runtime-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '45.3.1' })
  t.after(() => {
    if (originalElectron) Object.defineProperty(process.versions, 'electron', originalElectron)
    else delete process.versions.electron
  })
  const envFile = join(root, 'test.env')
  await writeFile(envFile, 'DEEPSEEK_API_KEY=test-only-key\n')
  const service = createHarnessEngine({ appRoot: root, resourcesPath: join(root, 'resources'), storageDir: root, envFile })
  const dev = join(root, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(dev, 'lib'), { recursive: true })
  await writeFile(join(dev, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'development' }))
  await writeFile(join(dev, 'lib/bin.js'), '')
  const unavailable = await service.engine()
  assert.equal(unavailable.available, false)
  assert.match(unavailable.message, /独立 Node/)

  const runtime = join(root, 'resources/dsh-runtime')
  const dsh = join(runtime, 'node_modules/@deepseek-ai/dsh')
  const node = join(runtime, 'node_modules/node/bin/node')
  const npm = join(runtime, 'node_modules/npm/bin/npm-cli.js')
  await mkdir(join(dsh, 'lib'), { recursive: true })
  await mkdir(join(runtime, 'node_modules/node/bin'), { recursive: true })
  await mkdir(join(runtime, 'node_modules/npm/bin'), { recursive: true })
  await mkdir(join(runtime, 'bin'), { recursive: true })
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'packaged' }))
  // The wrapper proves the app launches the bundled executable rather than
  // reusing process.execPath, even though this test itself runs under Node.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(node, '#!/bin/sh\nexport ROVE_RUNTIME_TEST=bundled\nexec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o755 })
  await writeFile(npm, '#!/usr/bin/env node\nconsole.log("bundled-npm")\n', { mode: 0o755 })
  await symlink('../node_modules/npm/bin/npm-cli.js', join(runtime, 'bin/npm'))
  await writeFile(join(dsh, 'lib/bin.js'), `
    const assert = require('node:assert/strict')
    const {execFileSync} = require('node:child_process')
    assert.equal(process.versions.electron, undefined)
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(process.env.ROVE_RUNTIME_TEST, 'bundled')
    assert.equal(execFileSync('npm', ['--version'], {encoding:'utf8'}).trim(), 'bundled-npm')
    assert.equal(execFileSync('node', ['-p', 'process.env.ROVE_RUNTIME_TEST'], {encoding:'utf8'}).trim(), 'bundled')
    process.stdin.resume()
    process.stdin.on('end', () => console.log(JSON.stringify({type:'final', reason:{kind:'completed'}, text:'standalone runtime works'})))
  `)
  await chmod(node, 0o644)
  assert.equal((await service.engine()).available, false)
  await chmod(node, 0o755)
  const available = await service.engine()
  assert.equal(available.available, true)
  assert.equal(available.version, 'packaged')
  const result = await service.runHarness({ cwd: root, prompt: 'runtime check', kind: 'edit', signal: new AbortController().signal, onProgress() {} })
  assert.equal(result.answer, 'standalone runtime works')
})


async function traceFixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), 'rove-dsh-trace-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(folder, 'lib'), { recursive: true })
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'trace-test', type: 'commonjs' }))
  await writeFile(join(folder, 'lib/bin.js'), script)
  const envFile = join(root, 'test.env')
  await writeFile(envFile, 'DEEPSEEK_API_KEY=trace-configured-secret\nDEEPSEEK_BASE_URL=http://localhost:32839/anthropic\nDEEPSEEK_MODEL=trace-model\n')
  const service = createHarnessEngine({ appRoot: root, resourcesPath: join(root, 'resources'), storageDir: root, envFile })
  return { root, run: (prompt, extra = {}) => service.runHarness({ cwd: root, prompt, kind: 'edit',
    signal: new AbortController().signal, onProgress() {}, ...extra }) }
}

test('the complete public event stream is durably awaited, ordered and credential-redacted', async t => {
  const { run } = await traceFixture(t, `
    const fs = require('node:fs')
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    const emit = event => fs.writeSync(1, JSON.stringify(event) + '\\n')
    ;(async () => {
      for await (const chunk of process.stdin) {}
      const key = process.env.DEEPSEEK_API_KEY
      emit({type:'session', sessionId:'public-session'})
      emit({type:'status', phase:'step_start', step:0, custom:{retained:true}})
      emit({type:'thinking', text:'DSH public thinking event'})
      emit({type:'text', text:'intermediate assistant text'})
      emit({type:'tool_call', callId:'call-one', tool:'write_file', input:{path:'index.html', nested:{headers:{authorization:key}, token:'sk-abcdefghijklmnop', count:7}, array:[key,null,true]}})
      emit({type:'tool_result', callId:'call-one', status:'completed', result:'x'.repeat(131072), truncated:true, structured:{answer:42}})
      emit({type:'future_event', arbitrary:{deep:{field:key}}, keep:['a',2,false], truncated:false})
      emit({type:'error', message:'diagnostic event '+key, details:{retryable:true}})
      // Deliberately split configured and recognizable credentials across chunks.
      fs.writeSync(2, 'stderr prefix '+key.slice(0,9)); await delay(15)
      fs.writeSync(2, key.slice(9)+' plus sk-abc'); await delay(15)
      fs.writeSync(2, 'defghijklmnopqrstuvwxyz'); await delay(15)
      fs.writeSync(2, ' suffix without newline')
      for (let i=0;i<80;i++) emit({type:'future_burst', ordinal:i, data:'z'.repeat(4096)})
      fs.writeSync(1, JSON.stringify({type:'final', reason:{kind:'completed'}, text:'finished '+key}))
    })().catch(error => { console.error(error); process.exitCode=2 })
  `)
  const events = [], progress = []
  let active = 0, highest = 0
  const result = await run('trace', { onProgress: message => progress.push(message), onEvent: async event => {
    highest = Math.max(highest, ++active)
    await new Promise(resolve => setTimeout(resolve, 1))
    events.push(event)
    active--
  } })
  assert.equal(active, 0, 'run must await the final journal write')
  assert.equal(highest, 1, 'journal writes are serial across stdout and stderr')
  assert.equal(events[0].type, 'runtime')
  assert.equal(events[0].version, 'trace-test')
  assert.equal(events[0].model, 'trace-model')
  assert.equal(events[0].baseURL, 'http://localhost:32839/anthropic')
  assert.equal(events.at(-1).type, 'process_exit')
  assert.equal(events.at(-1).code, 0)
  const types = events.filter(event => !['runtime','diagnostic','process_exit'].includes(event.type)).map(event => event.type)
  assert.deepEqual(types.slice(0,8), ['session','status','thinking','text','tool_call','tool_result','future_event','error'])
  assert.equal(types.at(-1), 'final')
  const call = events.find(event => event.type === 'tool_call')
  assert.equal(call.callId, 'call-one')
  assert.equal(call.input.path, 'index.html')
  assert.equal(call.input.nested.count, 7)
  assert.deepEqual(call.input.array, ['[密钥已省略]',null,true])
  const toolResult = events.find(event => event.type === 'tool_result')
  assert.equal(toolResult.result.length, 131072)
  assert.equal(toolResult.truncated, true)
  assert.deepEqual(toolResult.structured, {answer:42})
  assert.deepEqual(events.filter(event => event.type === 'future_burst').map(event => event.ordinal), Array.from({length:80},(_,i)=>i))
  const unknown = events.find(event => event.type === 'future_event')
  assert.deepEqual(unknown.keep, ['a',2,false])
  assert.equal(unknown.truncated, false)
  assert.equal(events.find(event => event.type === 'thinking').text, 'DSH public thinking event')
  assert.ok(progress.every(message => !message.includes('thinking')))
  const diagnostics = events.filter(event => event.type === 'diagnostic').map(event => event.text).join('')
  assert.equal(diagnostics, 'stderr prefix [密钥已省略] plus [密钥已省略] suffix without newline')
  assert.ok(!JSON.stringify(events).includes('trace-configured-secret'))
  assert.ok(!JSON.stringify(events).includes('sk-abcdefghijklmnopqrstuvwxyz'))
  assert.equal(result.answer, 'finished [密钥已省略]')
})

test('protocol failures and cancellation preserve events before the process exits', async t => {
  const { run } = await traceFixture(t, `
    const fs = require('node:fs')
    const emit = event => fs.writeSync(1, JSON.stringify(event) + '\\n')
    process.on('SIGTERM', () => {
      emit({type:'final', reason:{kind:'cancelled'}, text:'stopped with current files'})
      process.exit(0)
    })
    ;(async () => {
      let task=''; for await (const chunk of process.stdin) task+=chunk
      emit({type:'session',sessionId:'recorded-session'})
      if(task==='invalid') { fs.writeSync(1, 'invalid JSON '+process.env.DEEPSEEK_API_KEY+'\\n'); return }
      emit({type:'tool_call',callId:'pending',tool:'bash',input:{command:'sleep'}})
      setInterval(()=>{},50)
    })()
  `)
  const invalid = []
  await assert.rejects(run('invalid', {onEvent: event => {invalid.push(event)}}), /JSON/)
  assert.ok(invalid.some(event => event.type === 'session'))
  assert.ok(invalid.some(event => event.type === 'protocol_error' && event.text.includes('[密钥已省略]')))
  assert.equal(invalid.at(-1).type, 'process_exit')
  const controller = new AbortController(), stopped = []
  const result = await run('cancel', { signal:controller.signal, onEvent: event => {
    stopped.push(event)
    if(event.type==='tool_call') controller.abort()
  } })
  assert.equal(result.cancelled, true)
  assert.deepEqual(stopped.filter(event=>['session','tool_call','final','process_exit'].includes(event.type)).map(event=>event.type), ['session','tool_call','final','process_exit'])
  assert.ok(!JSON.stringify(invalid).includes('trace-configured-secret'))
})

test('a failing event writer stops the child and reports incomplete recording', async t => {
  const { root, run } = await traceFixture(t, `
    const fs=require('node:fs')
    const emit=event=>fs.writeSync(1,JSON.stringify(event)+'\\n')
    fs.writeFileSync('spawned.txt','started')
    ;(async()=>{
      for await(const chunk of process.stdin){}
      emit({type:'session'})
      emit({type:'tool_call',tool:'write_file',input:{path:'output'}})
      setInterval(()=>emit({type:'status',phase:'step_start'}),25)
    })()
  `)
  await assert.rejects(run('runtime-write-fails', { onEvent: () => { throw new Error('runtime storage unavailable') } }), /运行记录写入失败.*runtime storage unavailable/)
  await assert.rejects(lstat(join(root,'spawned.txt')), {code:'ENOENT'})
  const events = [], started = Date.now()
  await assert.rejects(run('stream-write-fails', { onEvent: event => {
    if(event.type==='tool_call') throw new Error('disk full')
    events.push(event)
  } }), /运行记录写入失败.*disk full/)
  assert.ok(Date.now()-started<5000)
  const count = events.length
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal(events.length,count,'there must be no late writes after failure returns')
  assert.ok(events.some(event=>event.type==='session'))
  assert.deepEqual(await readdir(join(root,'coding/dsh')),[])
})

test('event redaction preserves nested values and escaped configured keys', () => {
  const key='secret-"quote"-\\-换行\n'
  const event={type:'unknown',text:key,deep:{array:[key,1,null],other:'ghp_abcdefghijklmnopqrstuv'},number:42,truncated:true,
    fields:{'sk-abcdefghijklmnopqrstuv':'one','sk-zyxwvutsrqponmlkjihg':'two'}}
  const safe=sanitizeHarnessEvent(event,key)
  assert.equal(safe.text,'[密钥已省略]')
  assert.deepEqual(safe.deep.array,['[密钥已省略]',1,null])
  assert.equal(safe.deep.other,'[密钥已省略]')
  assert.equal(safe.number,42)
  assert.equal(safe.truncated,true)
  assert.deepEqual(Object.values(safe.fields),['one','two'])
  assert.deepEqual(Object.keys(safe.fields),['[密钥已省略]','[密钥已省略] [2]'])
})
