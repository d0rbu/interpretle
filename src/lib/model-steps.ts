import type { InferenceSession, Tensor } from 'onnxruntime-web'

export type ModelStep = { label: string; session: InferenceSession }

/** Execute the original graph in pieces, releasing intermediates after use. */
export async function runSteps(
  steps: ModelStep[],
  feeds: Record<string, Tensor>,
  outputs: string[],
  progress: (label: string, finished: boolean) => void,
  timing?: (label: string, start: number, failed: boolean) => void,
) {
  const values = { ...feeds }
  const owned = new Map<string, Tensor>()
  let complete = false
  try {
    for (const [index, { label, session }] of steps.entries()) {
      progress(label, false)
      const start = performance.now()
      let result: Record<string, Tensor>
      try {
        result = await session.run(
          Object.fromEntries(
            session.inputNames.map((name) => [name, values[name]]),
          ),
        )
      } catch (cause) {
        timing?.(label, start, true)
        throw cause
      }
      timing?.(label, start, false)
      Object.assign(values, result)
      for (const [name, tensor] of Object.entries(result))
        owned.set(name, tensor)
      const needed = new Set([
        ...outputs,
        ...steps.slice(index + 1).flatMap((step) => step.session.inputNames),
      ])
      for (const [name, tensor] of owned) {
        if (!needed.has(name)) {
          tensor.dispose()
          owned.delete(name)
          delete values[name]
        }
      }
      progress(label, true)
    }
    complete = true
    return Object.fromEntries(outputs.map((name) => [name, values[name]]))
  } finally {
    for (const [name, tensor] of owned)
      if (!complete || !outputs.includes(name)) tensor.dispose()
  }
}
