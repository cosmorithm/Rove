import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

function buildCommit(): string {
  try {
    const [root, head] = execFileSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
      cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim().split('\n')
    if (realpathSync(root) === realpathSync(__dirname) && /^[0-9a-f]{40}$/i.test(head)) return head
  } catch { /* Source archives may have neither .git nor a Git executable. */ }
  const sha = process.env.GITHUB_SHA ?? ''
  return process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY?.toLowerCase() === 'cosmorithm/rove'
    && /^[0-9a-f]{40}$/i.test(sha) ? sha : ''
}

export default defineConfig({
  main: {
    define: { __ROVE_BUILD_COMMIT__: JSON.stringify(buildCommit()) },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(__dirname, 'electron/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(__dirname, 'electron/preload/index.ts') } }
  },
  renderer: {
    root: '.',
    plugins: [
      vue(),
      {
        name: 'pdf-reading-assets',
        apply: 'build',
        generateBundle() {
          for (const folder of ['cmaps', 'standard_fonts']) {
            const dir = resolve(__dirname, 'node_modules/pdfjs-dist', folder)
            for (const name of readdirSync(dir)) {
              this.emitFile({
                type: 'asset',
                fileName: `pdfjs/${folder}/${name}`,
                source: readFileSync(resolve(dir, name))
              })
            }
          }
        }
      }
    ],
    build: { rollupOptions: { input: resolve(__dirname, 'index.html') } }
  }
})
