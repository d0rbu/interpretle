import type { ModelProfile } from '../src/lib/model-profile'

// Synthetic timings for telemetry and display tests, never model benchmarks.
export const profileFixture = (
  changes: Partial<ModelProfile> = {},
): ModelProfile => ({
  version: 1,
  startedAt: '2026-10-18T12:00:00.000Z',
  release: 'test-build',
  manifest: '/model/manifest-v4-fp4.json',
  backend: 'gpu',
  threads: 1,
  run: 1,
  tokens: 20,
  status: 'ok',
  totalMs: 2000,
  steps: [
    { kind: 'tokenize', name: 'Tokenization', startMs: 0, ms: 2 },
    {
      kind: 'weights',
      name: 'Read & prepare weights',
      layer: 0,
      startMs: 2,
      ms: 800,
      readMs: 300,
      decodeMs: 450,
      bytes: 1000000,
    },
    {
      kind: 'wait',
      name: 'Await layer weights',
      layer: 0,
      startMs: 400,
      ms: 402,
    },
    { kind: 'compute', name: 'Q projection', layer: 0, startMs: 802, ms: 250 },
    { kind: 'compute', name: 'Attention', layer: 0, startMs: 1052, ms: 450 },
    { kind: 'readback', name: 'Activation readback', startMs: 1502, ms: 350 },
    { kind: 'activation', name: 'Feature activation', startMs: 1852, ms: 100 },
  ],
  ...changes,
})
