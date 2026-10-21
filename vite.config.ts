import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const builtAt = new Date().toISOString()
const release = `${commit}-${builtAt.replace(/[-:.]/g, '')}`

// Archive exact builds privately; keep recent public bundles for resumed tabs.
const privateMaps = {
  name: 'private-source-maps',
  apply: 'build' as const,
  closeBundle() {
    const archive = join('artifacts', 'releases', release)
    const maps: string[] = []
    function move(directory: string, relative = '') {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(relative, entry.name)
        if (entry.isDirectory()) move(join(directory, entry.name), file)
        else if (file.endsWith('.map')) {
          const destination = join(archive, file)
          mkdirSync(dirname(destination), { recursive: true })
          renameSync(join(directory, entry.name), destination)
          maps.push(file)
        } else if (relative === 'assets' && /\.(js|css)$/.test(entry.name)) {
          const destination = join(archive, file)
          mkdirSync(dirname(destination), { recursive: true })
          copyFileSync(join(directory, entry.name), destination)
        }
      }
    }
    move('dist')
    if (!maps.length)
      throw new Error('No source maps were produced for this build.')
    const record = JSON.stringify({ release, commit, builtAt, maps }, null, 2)
    writeFileSync(join(archive, 'build.json'), record)
    writeFileSync('artifacts/last-build.json', record)
    // A tab resumed after deployment still requests its original worker URLs.
    // Retain seven days of public bundles, never their private source maps.
    for (const previous of readdirSync('artifacts/releases')) {
      const directory = join('artifacts/releases', previous)
      const metadata = join(directory, 'build.json')
      if (!existsSync(metadata)) continue
      const { builtAt: previousBuild } = JSON.parse(
        readFileSync(metadata, 'utf8'),
      )
      if (!(Date.parse(previousBuild) >= Date.parse(builtAt) - 7 * 86400000))
        continue
      const assets = join(directory, 'assets')
      if (!existsSync(assets)) continue
      for (const entry of readdirSync(assets, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(js|css)$/.test(entry.name)) continue
        const destination = join('dist/assets', entry.name)
        if (!existsSync(destination))
          copyFileSync(join(assets, entry.name), destination)
      }
    }
  },
}

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react(), privateMaps],
  define: { __APP_BUILD__: JSON.stringify(release) },
  build: { sourcemap: 'hidden' },
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  optimizeDeps: {
    include: [
      '@huggingface/tokenizers',
      'onnxruntime-web/webgpu',
      'onnxruntime-web/wasm',
    ],
  },
  server: {
    headers: isolation,
    watch: { ignored: ['**/.venv/**', '**/artifacts/**'] },
  },
  preview: { headers: isolation },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
})
