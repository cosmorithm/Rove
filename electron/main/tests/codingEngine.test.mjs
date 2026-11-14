import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnessEngine } from '../codingEngine.ts'

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
      emit({type:'thinking', text:'private reasoning'})
      emit({type:'tool_call', tool:'read_file', input:'private command'})
      emit({type:'tool_result', status:'completed', result:'private content'})
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
