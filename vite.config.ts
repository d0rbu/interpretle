import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
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
