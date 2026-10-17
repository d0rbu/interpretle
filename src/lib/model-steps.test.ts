import type { InferenceSession, Tensor } from 'onnxruntime-web'
import { expect, it, vi } from 'vitest'
import { runSteps } from './model-steps'

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
