// Run after `npm run build`: node_modules/.bin/electron src/tests/canvasInteractions.electron.cjs
// Uses a disposable profile, fake projects and IPC responses; never opens real projects or calls a model.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '../..')
const profile = mkdtempSync(join(tmpdir(), 'rove-canvas-interactions-'))
app.setPath('userData', profile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const card = (id, children = []) => ({ id, question: id, answer: 'Fixture answer', excerpt: '', demo: false, children })
const blocks = () => [{ id: 'topic', title: 'Fixture topic', body: '', cards: [card('parent', [card('child')]), card('sibling')] }]
const notes = ['a', 'b'].map(id => ({ id, name: 'Same display name', label: '对话', kind: 'chat', blocks: blocks() }))
const projects = ['a', 'b'].map(id => ({ id, name: 'Same display name', root: '/virtual/' + id,
  workspaces: [{ id: 'workspace-' + id, projectId: id, path: '/virtual/' + id, branch: 'main', name: 'main', isMain: true }] }))
const coding = { activeProject: 'a', projects: Object.fromEntries(projects.map(project => [project.id,
  { activeWorkspace: project.workspaces[0].id, blocks: blocks(), meta: {}, prompts: {} }])) }
const sources = new Map()
ipcMain.handle('ai:config', () => ({ baseUrl: '', model: '', provider: 'deepseek', configured: false, hasApiKey: false }))
ipcMain.handle('study-context:get', (event, id) => sources.get(id) ?? null)
ipcMain.handle('study-context:save', (event, source) => {
  const metadata = { nodeId: source.nodeId, parentId: source.parentId, versions: [{ revision: 'fixture', source, state: 'ready',
    summaries: Object.fromEntries(['L0', 'L1', 'L2'].map(level => [level, { text: source.question, generatedAt: new Date().toISOString() }])) }] }
  sources.set(source.nodeId, metadata)
  return metadata
})
ipcMain.handle('coding:list-projects', () => projects)
ipcMain.handle('coding:engine', () => ({ available: false, authenticated: false, version: '', message: 'Isolated canvas test' }))
ipcMain.handle('coding:status', (event, id) => {
  const workspace = projects.flatMap(project => project.workspaces).find(workspace => workspace.id === id)
  assert.ok(workspace, 'only fixture workspaces may be inspected')
  return { workspace, head: 'fixture', branch: 'main', dirty: false, files: [], changes: [] }
})

app.whenReady().then(async () => {
  app.dock?.hide()
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false } })
  const timeout = setTimeout(() => { console.error('Canvas interaction test timed out'); win.destroy(); app.exit(2) }, 60000)
  const evaluate = code => win.webContents.executeJavaScript(code)
  await win.loadURL('about:blank')
  win.webContents.debugger.attach('1.3')
  const send = (method, params = {}) => win.webContents.debugger.sendCommand(method, params)
  await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (!localStorage.getItem('canvas-fixture-seeded')) {
      localStorage.setItem('zhixue-library-v2', ${JSON.stringify(JSON.stringify({ active: 'a', notes }))});
      localStorage.setItem('rove-coding-v1', ${JSON.stringify(JSON.stringify(coding))});
      localStorage.setItem('rove-workspace-mode', 'chat');
      localStorage.setItem('canvas-fixture-seeded', '1');
    }
  ` })
  const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, buttons,
    button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2, `${label}: ${actual} vs ${expected}`)
  const saved = scope => evaluate(`localStorage.getItem(${JSON.stringify('rove-map-layout-v1:' + scope)})`)
  const state = () => evaluate(`(() => {
    const view = document.querySelector('.canvas-scroll'), plane = document.querySelector('.canvas-plane');
    if (!view || !plane) return null;
    const v = view.getBoundingClientRect(), p = plane.getBoundingClientRect();
    return { left: view.scrollLeft, top: view.scrollTop, x:v.x, y:v.y, width:view.clientWidth, height:view.clientHeight,
      scale:new DOMMatrixReadOnly(getComputedStyle(plane).transform).a, planeX:p.x, planeY:p.y,
      selected:document.querySelector('.canvas-node[aria-current]')?.dataset.node,
      nodes:Object.fromEntries([...document.querySelectorAll('.canvas-node')].map(node => {
        const r=node.getBoundingClientRect(); return [node.dataset.node,{x:r.x,y:r.y,width:r.width,height:r.height,
          cssX:parseFloat(node.style.left),cssY:parseFloat(node.style.top)}];
      })), edges:Object.fromEntries([...document.querySelectorAll('.canvas-edges path')].map(path => [path.dataset.child,path.getAttribute('d')])),
      dragging:!!document.querySelector('.canvas-node.is-dragging') };
  })()`)
  async function waitFor(code) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code)) { await pause(100); return }
      await pause(30)
    }
    throw new Error('Timed out waiting for: ' + code)
  }
  const waitForMap = () => waitFor(`document.querySelectorAll('.canvas-node').length === 4`)
  async function reload() {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve))
    win.webContents.reload(); await loaded; await waitForMap()
  }
  let lastGesture
  async function dragNode(key, dx, dy) {
    await evaluate(`document.querySelector(${JSON.stringify('[data-node="' + key + '"]')}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    const before = await state(), node = before.nodes[key]
    const x = node.x + node.width / 2, y = node.y + node.height / 2
    lastGesture = { key, dx, dy, before, steps: [] }
    await evaluate(`window.fixtureMoves=[]; if(!window.fixtureMoveListener){window.fixtureMoveListener=e=>{if(e.buttons)fixtureMoves.push({x:e.clientX,y:e.clientY,id:e.pointerId,target:e.target?.dataset?.node})};window.addEventListener('pointermove',fixtureMoveListener,true)}`)
    await mouse('mouseMoved', x, y)
    await mouse('mousePressed', x, y, 1)
    for (let step = 1; step <= 6; step++) {
      await mouse('mouseMoved', x + dx * step / 6, y + dy * step / 6, 1)
      await pause(20)
      const stepState = await state()
      lastGesture.steps.push({ step, node: stepState.nodes[key], planeX: stepState.planeX, planeY: stepState.planeY, left: stepState.left, top: stepState.top })
    }
    await pause(60) // Chromium may coalesce mouse moves until the next frame.
    const during = await state()
    assert.equal(during.dragging, true)
    near(during.nodes[key].x, before.nodes[key].x + dx, key + ' horizontal movement')
    near(during.nodes[key].y, before.nodes[key].y + dy, key + ' vertical movement')
    for (const other of Object.keys(before.nodes).filter(other => other !== key)) {
      near(during.nodes[other].x, before.nodes[other].x, other + ' must not move horizontally')
      near(during.nodes[other].y, before.nodes[other].y, other + ' must not move vertically')
    }
    await mouse('mouseReleased', x + dx, y + dy)
    await pause(60)
    const after = await state()
    assert.equal(after.dragging, false)
    assert.equal(after.selected, before.selected, 'releasing a drag must not activate the node')
    return { before, after }
  }
  function assertEdges(layout) {
    const parentOf = { 'q/parent': 'b/topic', 'q/child': 'q/parent', 'q/sibling': 'b/topic' }
    for (const [child, parent] of Object.entries(parentOf)) {
      const numbers = layout.edges[child].match(/-?\d+(?:\.\d+)?/g).map(Number)
      const from = layout.nodes[parent], to = layout.nodes[child]
      const right = to.x + to.width / 2 >= from.x + from.width / 2
      near(layout.planeX + numbers[0] * layout.scale, from.x + (right ? from.width : 0), child + ' edge start x')
      near(layout.planeY + numbers[1] * layout.scale, from.y + from.height / 2, child + ' edge start y')
      near(layout.planeX + numbers.at(-2) * layout.scale, to.x + (right ? 0 : to.width), child + ' edge end x')
      near(layout.planeY + numbers.at(-1) * layout.scale, to.y + to.height / 2, child + ' edge end y')
    }
  }
  async function clickNode(key) {
    const node = (await state()).nodes[key], x = node.x + node.width / 2, y = node.y + node.height / 2
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y)
    await pause(100)
  }
  async function mode(name) {
    await evaluate(`[...document.querySelectorAll('.workspace-modes button')].find(button=>button.textContent===${JSON.stringify(name)}).click()`)
    await waitForMap()
  }
  async function project(id) {
    await evaluate(`(() => {const select=document.querySelector('[data-testid="coding-project"]');select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    await waitForMap()
  }
  try {
    await win.loadFile(join(root, 'out/renderer/index.html'))
    await waitForMap()
    assert.equal(await saved('chat:a'), null)
    const first = await dragNode('q/parent', 60, 70)
    assertEdges(first.after)
    assert.notEqual(first.after.edges['q/parent'], first.before.edges['q/parent'])
    assert.notEqual(first.after.edges['q/child'], first.before.edges['q/child'])
    const firstSaved = JSON.parse(await saved('chat:a')).positions
    near(firstSaved['q/parent'].x, first.before.nodes['q/parent'].cssX + 60 / first.before.scale, 'saved node x')
    await clickNode('q/parent')
    assert.equal((await state()).selected, 'q/parent', 'normal clicks still open the node')
    console.log('PASS: independent node movement, live incident edges, no drag-click activation, ordinary clicks')

    await evaluate(`document.querySelector('[aria-label="放大"]').click()`)
    await pause(100)
    assert.equal((await state()).scale, 1.2)
    const zoomed = await dragNode('q/parent', 72, 48)
    assertEdges(zoomed.after)
    const zoomSaved = JSON.parse(await saved('chat:a')).positions
    near(zoomSaved['q/parent'].x, firstSaved['q/parent'].x + 60, 'zoom-aware saved x')
    near(zoomSaved['q/parent'].y, firstSaved['q/parent'].y + 40, 'zoom-aware saved y')
    const negative = await dragNode('b/topic', -120, -220)
    assertEdges(negative.after)
    const aSaved = await saved('chat:a'), aPositions = JSON.parse(aSaved).positions
    assert.ok(aPositions['b/topic'].x < 0 && aPositions['b/topic'].y < 0, 'negative coordinates remain draggable')
    await evaluate(`document.querySelector('.fit-tool').click()`)
    await pause(100)
    const fitted = await state()
    for (const node of Object.values(fitted.nodes)) {
      assert.ok(node.x >= fitted.x - 2 && node.y >= fitted.y - 2)
      assert.ok(node.x + node.width <= fitted.x + fitted.width + 2)
      assert.ok(node.y + node.height <= fitted.y + fitted.height + 2)
    }
    await reload()
    assert.equal(await saved('chat:a'), aSaved)
    const restored = await state()
    const minX = Math.min(0, ...Object.values(aPositions).map(point => point.x - 40))
    const minY = Math.min(0, ...Object.values(aPositions).map(point => point.y - 40))
    for (const [key, point] of Object.entries(aPositions)) {
      near(restored.nodes[key].cssX, point.x - minX, key + ' restored x')
      near(restored.nodes[key].cssY, point.y - minY, key + ' restored y')
    }
    assertEdges(restored)
    console.log('PASS: zoom-aware dragging, negative bounds without shifting other nodes, reload persistence')

    await evaluate(`document.querySelectorAll('.library-item')[1].click()`)
    await waitForMap()
    assert.equal(await saved('chat:b'), null)
    await dragNode('q/parent', 55, 35)
    assert.equal(await saved('chat:a'), aSaved, 'same-named conversations have independent layouts')
    const bSaved = await saved('chat:b')
    await evaluate(`document.querySelectorAll('.library-item')[0].click()`)
    await waitForMap()
    assert.equal(await saved('chat:a'), aSaved)
    console.log('PASS: per-conversation layout isolation with identical node IDs and display names')

    await mode('Coding')
    assert.equal(await saved('coding:a'), null)
    await dragNode('q/parent', 70, 60)
    const codingA = await saved('coding:a')
    assert.equal(await saved('chat:a'), aSaved, 'Coding cannot overwrite Chat positions')
    await project('b')
    assert.equal(await saved('coding:b'), null)
    await dragNode('q/parent', 40, 30)
    const codingB = await saved('coding:b')
    await project('a')
    assert.equal(await saved('coding:a'), codingA)
    await reload()
    assert.equal(await saved('coding:a'), codingA)
    console.log('PASS: Coding node dragging, project isolation and reload persistence')

    await evaluate(`document.querySelector('.layout-reset').click()`)
    await pause(150)
    assert.deepEqual(JSON.parse(await saved('coding:a')).positions, {})
    assert.equal(await saved('coding:b'), codingB)
    assert.equal(await saved('chat:a'), aSaved)
    assert.equal(await saved('chat:b'), bSaved)
    const beforePan = await state(), x = beforePan.x + 20, y = beforePan.y + 35
    await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1)
    await mouse('mouseMoved', x + 50, y + 40, 1); await mouse('mouseReleased', x + 50, y + 40)
    await pause(60)
    const afterPan = await state()
    near(afterPan.left, beforePan.left - 50, 'background pan x')
    near(afterPan.top, beforePan.top - 40, 'background pan y')
    assert.deepEqual(JSON.parse(await saved('coding:a')).positions, {}, 'background panning cannot move saved nodes')
    console.log('PASS: automatic-layout reset is scoped, background panning remains independent')

    await evaluate(`document.querySelector('[data-node="b/topic"]').focus({preventScroll:true})`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    assert.equal(await evaluate(`document.activeElement.dataset.node`), 'q/parent')
    const beforeKeyboard = await state()
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 1 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, modifiers: 1 })
    const keyboard = JSON.parse(await saved('coding:a')).positions
    near(keyboard['q/parent'].x, beforeKeyboard.nodes['q/parent'].cssX + 16, 'keyboard adjustment')
    console.log('PASS: keyboard navigation and Alt+Arrow position adjustment')

    await evaluate(`(() => {window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('rove-map-layout-v1:'))throw new Error('fixture quota');return originalSetItem.call(this,key,value)}})()`)
    await dragNode('q/parent', 30, 20)
    assert.ok(await evaluate(`document.querySelector('.canvas-layout-error')?.textContent.includes('保存失败')`))
    await evaluate(`void (Storage.prototype.setItem=window.originalSetItem)`)
    await dragNode('q/parent', 20, 15)
    assert.equal(await evaluate(`!!document.querySelector('.canvas-layout-error')`), false)
    console.log('PASS: blocked storage keeps the map usable, reports failure and recovers on the next save')
    console.log('All Electron canvas interaction checks passed.')
    clearTimeout(timeout); win.destroy(); rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error.stack || error)
    console.error('Last map state:', await state().catch(() => null))
    console.error('Last gesture:', lastGesture)
    console.error('Pointer moves:', await evaluate('window.fixtureMoves').catch(() => null))
    clearTimeout(timeout); win.destroy(); rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
