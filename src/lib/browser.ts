import type { Catalog, Feature, TokenActivation } from './types'

type Progress = (message: string, fraction?: number) => void
let worker: Worker | undefined
let running = false
let ready = false

export const browserModelReady = () => ready

function run<T>(
  message: object,
  progress: Progress,
  signal: AbortSignal,
): Promise<T> {
  if (running)
    return Promise.reject(new Error('The local model is already busy.'))
  if (signal.aborted) return Promise.reject(new DOMException('', 'AbortError'))
  worker ??= new Worker(new URL('./model.worker.ts', import.meta.url), {
    type: 'module',
  })
  const current = worker
  running = true
  return new Promise((resolve, reject) => {
    function finish() {
      running = false
      signal.removeEventListener('abort', cancel)
      current.onmessage = null
      current.onerror = null
    }
    function cancel() {
      current.terminate()
      worker = undefined
      ready = false
      finish()
      reject(new DOMException('', 'AbortError'))
    }
    current.onmessage = ({ data }) => {
      if (data.progress) progress(data.progress, data.fraction)
      else {
        finish()
        if (data.error) {
          current.terminate()
          worker = undefined
          ready = false
          reject(new Error(data.error))
        } else {
          ready = true
          resolve(data.result as T)
        }
      }
    }
    current.onerror = () => {
      current.terminate()
      worker = undefined
      ready = false
      finish()
      reject(
        new Error(
          'The local model stopped. Please try again. No attempt was used.',
        ),
      )
    }
    signal.addEventListener('abort', cancel, { once: true })
    current.postMessage(message)
  })
}

export function prepareBrowserModel(
  model: NonNullable<Catalog['browserModel']>,
  progress: Progress,
  signal: AbortSignal,
) {
  return run<void>(
    { type: 'prepare', manifest: model.manifest },
    progress,
    signal,
  )
}

export function scoreInBrowser(
  text: string,
  feature: Feature,
  model: NonNullable<Catalog['browserModel']>,
  progress: Progress,
  signal: AbortSignal,
) {
  return run<TokenActivation[]>(
    {
      type: 'score',
      text,
      manifest: model.manifest,
      target: {
        kind: feature.kind,
        index: feature.index,
        encoder: feature.encoder,
      },
    },
    progress,
    signal,
  )
}
