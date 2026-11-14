import { resolve } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
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
