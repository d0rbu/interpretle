import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  optimizeDeps: {
    include: ['@huggingface/tokenizers', 'onnxruntime-web/webgpu'],
  },
  server: { watch: { ignored: ['**/.venv/**', '**/artifacts/**'] } },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
})
