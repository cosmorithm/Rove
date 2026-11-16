import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run after npm run build. The package contains the local Electron runtime and
// the three built Vite entries, DSH dependencies, and its standalone Node runtime.
if (process.platform !== 'darwin') throw new Error('请在 macOS 上打包。')
const project = resolve(fileURLToPath(new URL('../', import.meta.url)))
const displayName = 'Rove'
const target = join(project, displayName + '.app')
const bundleID = 'local.zhixu.study'
const runtime = join(project, 'node_modules/electron/dist')
const appPackage = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const actualVersion = (await readFile(join(runtime, 'version'), 'utf8')).trim().replace(/^v/, '')
if (actualVersion !== appPackage.devDependencies.electron) {
  throw new Error('安装的 Electron 版本与项目声明不一致。')
}
for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  await access(join(project, 'out', entry))
}

// Only replace a previous build of this app.
const plistPath = bundle => join(bundle, 'Contents/Info.plist')
const existing = await access(target).then(() => true, () => false)
if (existing) {
  const id = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plistPath(target)], { encoding: 'utf8' }).trim()
  if (id !== bundleID) throw new Error('目标路径已被其他应用占用。')
}
const stage = await mkdtemp(join(dirname(target), '.zhixu-build-'))
const bundle = join(stage, displayName + '.app')
const resources = join(bundle, 'Contents/Resources')
const app = join(resources, 'app')
const backup = join(stage, 'previous.app')
let previousInBackup = false
try {
  execFileSync('/usr/bin/ditto', [join(runtime, 'Electron.app'), bundle])
  for (const [key, value] of Object.entries({
    CFBundleIdentifier: bundleID, CFBundleDisplayName: displayName, CFBundleName: displayName,
    CFBundleVersion: appPackage.version, CFBundleShortVersionString: appPackage.version,
    LSApplicationCategoryType: 'public.app-category.productivity',
  })) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath(bundle)])
  }
  await mkdir(app)
  await cp(join(project, 'out'), join(app, 'out'), { recursive: true })
  await writeFile(join(app, 'package.json'), JSON.stringify({
    name: appPackage.name, productName: displayName, version: appPackage.version, main: appPackage.main,
  }, null, 2) + '\n')
  const dshRuntime = join(resources, 'dsh-runtime')
  await mkdir(dshRuntime)
  await writeFile(join(dshRuntime, 'package.json'), JSON.stringify({ name: 'rove-dsh-runtime', private: true }) + '\n')
  const modules = join(project, 'node_modules') + sep
  const productionPaths = [...new Set(execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    cwd: project, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }).trim().split('\n').filter(path => path.startsWith(modules)))].sort()
  // Copy a package's nested dependencies with it, preserving Node's resolution layout.
  const copied = []
  for (const path of productionPaths) {
    if (copied.some(parent => path.startsWith(parent + sep))) continue
    await cp(path, join(dshRuntime, relative(project, path)), { recursive: true })
    copied.push(path)
  }
  // DSH's native components support standalone Node, independently of Electron's V8.
  const nodeExecutable = join(dshRuntime, 'node_modules/node/bin/node')
  const nodeVersion = execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8' }).trim()
  if (nodeVersion !== 'v' + appPackage.dependencies.node) throw new Error('DSH 的 Node 运行时版本与项目声明不一致。')
  const tools = join(dshRuntime, 'bin')
  await mkdir(tools)
  await symlink('../node_modules/node/bin/node', join(tools, 'node'))
  for (const name of ['npm', 'npx']) {
    await access(join(dshRuntime, 'node_modules/npm/bin', name + '-cli.js'))
    await symlink('../node_modules/npm/bin/' + name + '-cli.js', join(tools, name))
  }
  const notices = join(resources, 'licenses')
  await mkdir(notices)
  for (const [source, name] of [
    [join(runtime, 'LICENSE'), 'Electron.txt'],
    [join(project, 'scripts/licenses/Node.txt'), 'Node.txt'],
    [join(project, 'node_modules/npm/LICENSE'), 'npm.txt'],
    [join(runtime, 'LICENSES.chromium.html'), 'Chromium.html'],
    [join(project, 'node_modules/vue/LICENSE'), 'Vue.txt'],
    [join(project, 'node_modules/katex/LICENSE'), 'KaTeX.txt'],
    [join(project, 'node_modules/marked/LICENSE.md'), 'Marked.md'],
    [join(project, 'node_modules/pdfjs-dist/LICENSE'), 'PDF.js.txt'],
  ]) await cp(source, join(notices, name))
  if (existing) {
    await rename(target, backup)
    previousInBackup = true
  }
  await rename(bundle, target)
  previousInBackup = false
  console.log(target)
} finally {
  if (previousInBackup) await rename(backup, target)
  await rm(stage, { recursive: true })
}
