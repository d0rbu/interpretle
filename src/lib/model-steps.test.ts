import type { InferenceSession, Tensor } from 'onnxruntime-web'
import { expect, it, vi } from 'vitest'
import { runSteps } from './model-steps'
import { ForwardProfile } from './model-profile'

const tensor = () => ({ dispose: vi.fn() }) as unknown as Tensor
const step = (
  label: string,
  inputNames: string[],
  run: (feeds: Record<string, Tensor>) => Promise<Record<string, Tensor>>,
) => ({ label, session: { inputNames, run } as unknown as InferenceSession })

it('reports real step completion and retains only live intermediate activations', async () => {
  const input = tensor(),
    q = tensor(),
    mlp = tensor(),
    output = tensor()
  const progress = vi.fn()
  const steps = [
    step('Q projection', ['input'], async (feeds) => {
      expect(feeds).toEqual({ input })
      expect(progress.mock.calls).toEqual([['Q projection', false]])
      return { q }
    }),
    step('MLP', ['input', 'q'], async (feeds) => {
      expect(feeds).toEqual({ input, q })
      expect(q.dispose).not.toHaveBeenCalled()
      return { mlp }
    }),
    step('Output', ['mlp'], async (feeds) => {
      expect(feeds).toEqual({ mlp })
      expect(q.dispose).toHaveBeenCalledOnce()
      return { output }
    }),
  ]
  expect(await runSteps(steps, { input }, ['output', 'mlp'], progress)).toEqual(
    { output, mlp },
  )
  expect(progress.mock.calls).toEqual([
    ['Q projection', false],
    ['Q projection', true],
    ['MLP', false],
    ['MLP', true],
    ['Output', false],
    ['Output', true],
  ])
  expect(input.dispose).not.toHaveBeenCalled()
  expect(q.dispose).toHaveBeenCalledOnce()
  expect(mlp.dispose).not.toHaveBeenCalled()
  expect(output.dispose).not.toHaveBeenCalled()
})

it('frees intermediates on failure without claiming that the failed step finished', async () => {
  const input = tensor(),
    q = tensor()
  const progress = vi.fn()
  const failure = new Error('Inference failed')
  await expect(
    runSteps(
      [
        step('Q projection', ['input'], async () => ({ q })),
        step('Attention', ['q'], async () => {
          throw failure
        }),
      ],
      { input },
      ['output'],
      progress,
    ),
  ).rejects.toBe(failure)
  expect(q.dispose).toHaveBeenCalledOnce()
  expect(input.dispose).not.toHaveBeenCalled()
  expect(progress.mock.calls.at(-1)).toEqual(['Attention', false])
})

it('measures actual session calls including a failed operation', async () => {
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const p = new ForwardProfile({
    backend: 'cpu',
    threads: 4,
    manifest: '/test',
    run: 1,
  })
  try {
    await expect(
      runSteps(
        [
          step('Q projection', ['input'], async () => {
            now += 12.5
            return { q: tensor() }
          }),
          step('Attention', ['q'], async () => {
            now += 20
            throw new Error('failed')
          }),
        ],
        { input: tensor() },
        ['output'],
        () => {},
        (name, start, failed) =>
          p.record('compute', name, start, 4, { failed }),
      ),
    ).rejects.toThrow('failed')
    expect(p.snapshot('error').steps).toMatchObject([
      { name: 'Q projection', layer: 4, startMs: 0, ms: 12.5, failed: false },
      { name: 'Attention', layer: 4, startMs: 12.5, ms: 20, failed: true },
    ])
  } finally {
    clock.mockRestore()
  }
})
