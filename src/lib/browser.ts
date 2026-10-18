import type { Catalog, Feature, TokenActivation } from './types'
import { modelError } from './model-error'
import { modelProblem, track } from './analytics'

type Progress = (message: string, fraction?: number) => void
type BrowserModel = NonNullable<Catalog['browserModel']>
type Preparation = {
  controller: AbortController
  promise: Promise<void>
  latest: Parameters<Progress>
  progress?: Progress
}
let worker: Worker | undefined
let running = false
let ready = false
let preparation: Preparation | undefined

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
    current.onerror = (event) => {
      current.terminate()
      worker = undefined
      ready = false
      finish()
      reject(new Error(modelError(event, 'Model worker')))
    }
    signal.addEventListener('abort', cancel, { once: true })
    current.postMessage(message)
  })
}

// iOS suspends hidden tabs. Keep preparation pending across sleep/offline,
// restarting the worker from the pieces already committed to CacheStorage.
async function prepareWhenActive(model: BrowserModel, job: Preparation) {
  const signal = job.controller.signal
  const active = () => !document.hidden && navigator.onLine !== false
  const watch = (callback: () => void) => {
    document.addEventListener('visibilitychange', callback)
    window.addEventListener('online', callback)
    window.addEventListener('offline', callback)
    signal.addEventListener('abort', callback)
    return () => {
      document.removeEventListener('visibilitychange', callback)
      window.removeEventListener('online', callback)
      window.removeEventListener('offline', callback)
      signal.removeEventListener('abort', callback)
    }
  }
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (signal.aborted || active()) {
          unwatch()
          if (signal.aborted) reject(new DOMException('', 'AbortError'))
          else resolve()
        }
      }
      const unwatch = watch(check)
      check()
    })
    const attempt = new AbortController()
    const unwatch = watch(() => {
      if (signal.aborted || !active()) attempt.abort()
    })
    if (signal.aborted || !active()) attempt.abort()
    try {
      await run<void>(
        { type: 'prepare', manifest: model.manifest },
        (...update) => {
          job.latest = update
          job.progress?.(...update)
        },
        attempt.signal,
      )
      return
    } catch (cause) {
      if (!attempt.signal.aborted || signal.aborted) throw cause
    } finally {
      unwatch()
    }
  }
}

function startPreparation(model: BrowserModel) {
  if (preparation) return preparation
  track('model_start')
  const job: Preparation = {
    controller: new AbortController(),
    latest: ['Loading…'],
    promise: Promise.resolve()
      .then(() => prepareWhenActive(model, job))
      .then(() => {
        track('model_ready')
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError')
          track('model_cancel')
        else track('model_error', { problem: modelProblem(cause) })
        throw cause
      })
      .finally(() => {
        if (preparation === job) preparation = undefined
      }),
  }
  preparation = job
  return job
}

export function prefetchBrowserModel(model: BrowserModel) {
  if (!ready) void startPreparation(model).promise.catch(() => {})
}

export async function prepareBrowserModel(
  model: BrowserModel,
  progress: Progress,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new DOMException('', 'AbortError')
  if (ready) return
  // Focusing the card joins the page's download and exposes its progress/cancel.
  const job = startPreparation(model)
  job.progress = progress
  progress(...job.latest)
  const cancel = () => job.controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await job.promise
  } finally {
    signal.removeEventListener('abort', cancel)
    if (job.progress === progress) job.progress = undefined
  }
}

export function scoreInBrowser(
  text: string,
  feature: Feature,
  model: BrowserModel,
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
      },
    },
    progress,
    signal,
  ).catch((cause) => {
    if (cause instanceof DOMException && cause.name === 'AbortError')
      track('model_cancel')
    else track('model_error', { problem: modelProblem(cause) })
    throw cause
  })
}
