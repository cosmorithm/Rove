import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { CodeFile, CodeProject, CodeStatus, CodeWorkspace } from '../../src/codingTypes'

interface TurnDetails {
  runId: string; nodeId: string; kind: 'ask' | 'edit'; before: string; prompt: string; context: string;
  answer: string; outcome: 'completed' | 'failed' | 'cancelled'
}
function turnRef(nodeId: string) {
  return 'refs/rove/turns/' + createHash('sha256').update(nodeId).digest('hex')
}

const exec = promisify(execFile)
const maxFile = 4 * 1024 * 1024
const fileHash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const failure = (error: unknown) => (error as NodeJS.ErrnoException).code

async function git(cwd: string, args: string[], index?: string, inspectError = false) {
  const env = { ...process.env }
  // Ignore inherited repository overrides; the picked directory is the authority.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  if (inspectError) env.LC_ALL = 'C'
  if (index) env.GIT_INDEX_FILE = index
  try {
    const result = await exec('/usr/bin/git', [
      '--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args
    ], { cwd, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
    return result.stdout
  } catch (reason) {
    const error = reason as { stderr?: Buffer; message: string }
    throw new Error((error.stderr?.toString().trim() || error.message).slice(0, 1600), { cause: reason })
  }
}
async function gitText(cwd: string, args: string[], index?: string) {
  return (await git(cwd, args, index)).toString().trimEnd()
}
async function head(cwd: string) {
  // This returns an empty string for an unborn branch.
  const result = await gitText(cwd, ['rev-parse', '--revs-only', 'HEAD'])
  return result.trim()
}
async function branch(cwd: string) {
  return (await gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => gitText(cwd, ['symbolic-ref', '--short', 'HEAD']))) || 'HEAD'
}
async function repositoryDirectory(cwd: string) {
  return realpath(resolve(cwd, await gitText(cwd, ['rev-parse', '--git-common-dir'])))
}
async function importRoot(selected: string) {
  const directory = await realpath(selected)
  if (!(await lstat(directory)).isDirectory()) throw new Error('请选择文件夹。')
  let root: string | undefined
  try {
    root = await realpath((await git(directory, ['rev-parse', '--show-toplevel'], undefined, true)).toString().replace(/\r?\n$/, ''))
  } catch (e) {
    const error = e as Error & { cause?: { code?: number } }
    const diagnostic = error.message.split('\n').at(-1) ?? ''
    if (error.cause?.code !== 128 || !/^fatal: not a git repository \(or any (?:of the )?parent/.test(diagnostic)) throw e
  }
  // A damaged .git directory can be skipped by discovery, even if a valid
  // outer repository exists. Never initialize over it or silently adopt its parent.
  for (let dir = directory; dir !== root; dir = dirname(dir)) {
    try {
      await lstat(join(dir, '.git'))
      throw new Error('检测到无法使用的 .git，请先修复现有仓库。')
    } catch (e) { if (failure(e) !== 'ENOENT') throw e }
    if (dirname(dir) === dir) break
  }
  if (root) return root
  await git(directory, ['init', '--initial-branch=main'])
  return directory
}
function cleanPath(path: string) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0') ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part))) {
    throw new Error('文件路径不在工作区内。')
  }
  return path
}
async function physicalFile(cwd: string, path: string) {
  cleanPath(path)
  const file = join(cwd, path)
  // Forbid symlinks even if their current target is inside. A later target can change.
  if (await realpath(file) !== file) throw new Error('符号链接不支持直接读写。')
  if (!(await lstat(file)).isFile()) throw new Error('请选择普通文件。')
  return file
}
function decode(path: string, bytes: Buffer): CodeFile {
  if (bytes.length > maxFile) throw new Error('编辑器支持 4 MiB 以内的文本文件。')
  if (bytes.includes(0)) throw new Error('这是二进制文件。')
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('编辑器仅支持 UTF-8 文本。') }
  return { path, content, hash: fileHash(bytes) }
}
async function readWorking(cwd: string, path: string) {
  const file = await physicalFile(cwd, path)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxFile) throw new Error('编辑器支持 4 MiB 以内的普通文本文件。')
    const actual = await realpath(file)
    if (actual !== file) throw new Error('文件路径已变化。')
    return { value: decode(path, await handle.readFile()), stat }
  } finally { await handle.close() }
}
function splitPaths(bytes: Buffer) { return bytes.toString().split('\0').filter(Boolean) }
async function revision(cwd: string, ref: string) {
  if (ref !== 'HEAD' && !/^[\da-f]{7,64}$/i.test(ref)) throw new Error('无效的代码版本。')
  return gitText(cwd, ['rev-parse', '--verify', ref + '^{commit}'])
}
async function knownFile(cwd: string, path: string) {
  cleanPath(path)
  const paths = splitPaths(await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path]))
  if (!paths.includes(path)) throw new Error('文件已删除，或未被此 Git 工作区收录。')
}
async function treeIndex<T>(cwd: string, callback: (index: string, tree: string) => Promise<T>) {
  const scratch = await mkdtemp(join(tmpdir(), 'rove-code-index-'))
  const index = join(scratch, 'index')
  try {
    const realIndex = resolve(cwd, await gitText(cwd, ['rev-parse', '--git-path', 'index']))
    try { await copyFile(realIndex, index) }
    catch (error) { if (failure(error) !== 'ENOENT') throw error }
    if (await gitText(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('请选择 Git 工作区。')
    await git(cwd, ['add', '-A', '--', '.'], index)
    return await callback(index, await gitText(cwd, ['write-tree'], index))
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
async function snapshot(cwd: string, message: string, previous?: string) {
  return treeIndex(cwd, async (_index, tree) => {
    const parent = await head(cwd)
    for (const candidate of [previous, parent]) {
      if (candidate && await gitText(cwd, ['rev-parse', candidate + '^{tree}']) === tree) return candidate
    }
    const id = await gitText(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])
    await git(cwd, ['update-ref', 'refs/rove/snapshots/' + randomUUID(), id])
    return id
  })
}

export class CodingStore {
  private registry: string
  private projects: CodeProject[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private ready: Promise<void>
  private busy = new Set<string>()

  private directory: string
  constructor(directory: string) {
    this.directory = directory
    this.registry = join(directory, 'projects.json')
    this.ready = this.load()
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.registry, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('项目列表格式无效。')
      this.projects = parsed
    } catch (error) { if (failure(error) !== 'ENOENT') throw error }
  }
  private async registryTransaction<T>(op: () => Promise<T>) {
    const next = this.queue.then(async () => { await this.ready; return op() })
    this.queue = next.catch(() => {})
    return next
  }
  private async saveProjects(projects: CodeProject[]) {
    const file = this.registry + '.' + randomUUID()
    try {
      await writeFile(file, JSON.stringify(projects), { flag: 'wx', mode: 0o600 })
      await rename(file, this.registry)
      this.projects = projects
    } finally { await rm(file, { force: true }) }
  }
  async listProjects() { await this.ready; await this.queue; return structuredClone(this.projects) }
  async importProject(selected: string) {
    return this.registryTransaction(async () => {
      const root = await importRoot(selected)
      const existing = this.projects.find(p => p.root === root || p.workspaces.some(w => w.path === root))
      if (existing) return structuredClone(existing)
      const common = await repositoryDirectory(root)
      for (const project of this.projects) {
        if (await repositoryDirectory(project.root).catch(() => undefined) !== common) continue
        // A directory chosen by the user is protected, even when Git calls it a linked worktree.
        const workspace = { id: randomUUID(), projectId: project.id, path: root, branch: await branch(root), name: basename(root), isMain: true }
        const updated = { ...project, workspaces: [...project.workspaces, workspace] }
        await this.saveProjects(this.projects.map(item => item.id === project.id ? updated : item))
        return structuredClone(updated)
      }
      const id = randomUUID()
      const workspace = { id: randomUUID(), projectId: id, path: root, branch: await branch(root), name: basename(root), isMain: true }
      const project = { id, name: basename(root), root, workspaces: [workspace] }
      await this.saveProjects([...this.projects, project])
      return structuredClone(project)
    })
  }
  async workspace(id: string) {
    await this.ready
    const workspace = this.projects.flatMap(p => p.workspaces).find(w => w.id === id)
    if (!workspace) throw new Error('找不到工作区。')
    if (await realpath(workspace.path) !== workspace.path ||
        await realpath(await gitText(workspace.path, ['rev-parse', '--show-toplevel'])) !== workspace.path) {
      throw new Error('工作区路径发生变化，请重新导入。')
    }
    return workspace
  }
  async locking<T>(id: string, fn: (workspace: CodeWorkspace) => Promise<T>) {
    if (this.busy.has(id)) throw new Error('此工作区正在执行其他操作。')
    this.busy.add(id)
    try { return await fn(await this.workspace(id)) }
    finally { this.busy.delete(id) }
  }
  async status(id: string): Promise<CodeStatus> {
    const workspace = await this.workspace(id)
    const cwd = workspace.path
    const [rawFiles, rawStatus, current, branchName] = await Promise.all([
      git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
      git(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']),
      head(cwd), branch(cwd)
    ])
    const changes = splitPaths(rawStatus).map(v => ({ status: v.slice(0, 2), path: v.slice(3) }))
    const deleted = new Set(changes.filter(v => v.status[1] === 'D').map(v => v.path))
    return { workspace: { ...workspace, branch: branchName }, head: current, branch: branchName, dirty: !!changes.length,
      files: [...new Set(splitPaths(rawFiles))].filter(f => !deleted.has(f)).sort(), changes }
  }
  async read(id: string, path: string, ref?: string) {
    const { path: cwd } = await this.workspace(id)
    cleanPath(path)
    if (ref) {
      const rev = await revision(cwd, ref)
      const entry = await gitText(cwd, ['ls-tree', '-z', rev, '--', path])
      const match = /^(100644|100755) blob ([a-f\d]+)\t/.exec(entry)
      if (!match) throw new Error('此版本未包含这个普通文件。')
      if (Number(await gitText(cwd, ['cat-file', '-s', match[2]])) > maxFile) throw new Error('文件过大。')
      return decode(path, await git(cwd, ['cat-file', 'blob', match[2]]))
    }
    await knownFile(cwd, path)
    return (await readWorking(cwd, path)).value
  }
  async save(id: string, path: string, content: string, expected: string) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxFile || content.includes('\0')) throw new Error('请输入有效的文本内容（最大 4 MiB）。')
    return this.locking(id, async workspace => {
      const cwd = workspace.path
      await knownFile(cwd, path)
      const first = await readWorking(cwd, path)
      if (expected !== first.value.hash) throw new Error('文件已被修改，请重新读取再保存。')
      const file = join(cwd, path)
      const temp = join(dirname(file), '.rove-save-' + randomUUID())
      const handle = await open(temp, 'wx', first.stat.mode & 0o777)
      try {
        try { await handle.writeFile(content); await handle.chmod(first.stat.mode & 0o777); await handle.sync() }
        finally { await handle.close() }
        const last = await readWorking(cwd, path)
        if (last.value.hash !== expected || last.stat.ino !== first.stat.ino) throw new Error('文件已被修改，请重新读取再保存。')
        await rename(temp, file)
        return decode(path, Buffer.from(content))
      } finally { await rm(temp, { force: true }) }
    })
  }
  async diff(id: string, from?: string, to?: string) {
    const cwd = (await this.workspace(id)).path
    const base = from ? await revision(cwd, from) : await head(cwd)
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--stat', '--patch']
    // Git's canonical empty tree also works for new repositories with no commits.
    const empty = await gitText(cwd, ['hash-object', '-t', 'tree', '-w', '/dev/null'])
    if (to) return (await git(cwd, [...args, base || empty, await revision(cwd, to), '--'])).toString()
    return treeIndex(cwd, async (_index, tree) => (await git(cwd, [...args, base || empty, tree, '--'])).toString())
  }
  async snapshot(workspace: CodeWorkspace, message: string, previous?: string) {
    return snapshot(workspace.path, message, previous)
  }
  async checkpoint(id: string, message: string) {
    if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw new Error('请输入提交说明。')
    return this.locking(id, async workspace => {
      const cwd = workspace.path
      const index = resolve(cwd, await gitText(cwd, ['rev-parse', '--git-path', 'index']))
      const lock = index + '.lock'
      const handle = await open(lock, 'wx')
      let published = false
      try {
        await treeIndex(cwd, async (temp, tree) => {
          const parent = await head(cwd)
          if (parent && await gitText(cwd, ['rev-parse', parent + '^{tree}']) === tree) throw new Error('当前修改与已提交版本相同。')
          // Do not accidentally finish or interfere with a user's merge/rebase/cherry-pick.
          for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge']) {
            const marker = resolve(cwd, await gitText(cwd, ['rev-parse', '--git-path', state]))
            if (await lstat(marker).then(() => true, e => { if (failure(e) !== 'ENOENT') throw e; return false })) {
              throw new Error('Git 当前有尚未完成的操作，请先在该仓库处理。')
            }
          }
          const commit = await gitText(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message])
          await handle.writeFile(await readFile(temp))
          await handle.sync()
          await git(cwd, ['update-ref', '-m', 'commit: ' + message.split('\n')[0], 'HEAD', commit, parent || '0'.repeat(commit.length)])
          try {
            await rename(lock, index)
            published = true
          } catch (error) {
            if (parent) await git(cwd, ['update-ref', 'HEAD', parent, commit])
            else await git(cwd, ['update-ref', '-d', 'HEAD', commit])
            throw error
          }
        })
      } finally { await handle.close(); if (!published) await rm(lock, { force: true }) }
      return this.status(id)
    })
  }
  async existingTurn(workspace: CodeWorkspace, nodeId: string) {
    const id = await gitText(workspace.path, ['rev-parse', '--revs-only', turnRef(nodeId)])
    if (!id) return
    const metadata = JSON.parse(await gitText(workspace.path, ['show', '-s', '--format=%b', id]))
    if (metadata.nodeId !== nodeId || typeof metadata.workspaceId !== 'string' || typeof metadata.before !== 'string' || typeof metadata.answer !== 'string') {
      throw new Error('已绑定的对话节点数据无效。')
    }
    return { answer: metadata.answer as string, before: metadata.before as string, after: id,
      cancelled: metadata.outcome === 'cancelled', status: await this.status(metadata.workspaceId) }
  }
  async turn(workspace: CodeWorkspace, parentCommit: string, details: TurnDetails) {
    const parent = await revision(workspace.path, parentCommit)
    return treeIndex(workspace.path, async (_index, tree) => {
      const scratch = await mkdtemp(join(tmpdir(), 'rove-turn-'))
      try {
        const message = join(scratch, 'message')
        const nonce = randomUUID()
        const subject = 'Rove · ' + details.kind + ' · ' + details.prompt.split('\n')[0].slice(0, 100)
        await writeFile(message, subject + '\n\n' + JSON.stringify({ ...details, workspaceId: workspace.id, nonce, version: 1 }), { mode: 0o600 })
        const id = await gitText(workspace.path, ['commit-tree', tree, '-p', parent, '-F', message])
        await git(workspace.path, ['update-ref', turnRef(details.nodeId), id, '0'.repeat(id.length)])
        return id
      } finally { await rm(scratch, { recursive: true, force: true }) }
    })
  }
  async fork(id: string, commit?: string, label?: string) {
    return this.locking(id, async workspace => {
      const base = commit ? await revision(workspace.path, commit) : await snapshot(workspace.path, 'Rove · 派生工作区')
      const suffix = randomUUID()
      const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 90) : '方案 ' + suffix.slice(0, 8)
      const branchName = 'rove/' + suffix
      const directory = join(this.directory, 'worktrees', workspace.projectId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = join(await realpath(directory), suffix)
      const nested = relative(workspace.path, target)
      if (!nested || !(nested.startsWith('..' + sep) || nested === '..' || isAbsolute(nested))) throw new Error('新工作区目录不能位于源仓库内。')
      try {
        await git(workspace.path, ['worktree', 'add', '-b', branchName, target, base])
      } catch (error) {
        // A failed checkout can leave behind the branch created by -b. Only remove it
        // if this exact unpublished branch still points to the expected commit.
        await git(workspace.path, ['update-ref', '-d', 'refs/heads/' + branchName, base]).catch(() => {})
        throw error
      }
      const fork: CodeWorkspace = { id: suffix, projectId: workspace.projectId, path: target, branch: branchName, name, isMain: false }
      try {
        await this.registryTransaction(() => this.saveProjects(this.projects.map(p =>
          p.id === workspace.projectId ? { ...p, workspaces: [...p.workspaces, fork] } : p)))
      } catch (error) {
        await git(workspace.path, ['worktree', 'remove', target])
        await git(workspace.path, ['branch', '-D', branchName])
        throw error
      }
      return fork
    })
  }
}
