import type { Catalog, Feature, TokenActivation, TokenSpan } from './types'
import { MODEL_BACKENDS, modelDiagnostics, modelError } from './model-error'
import type { ModelDiagnostics } from './model-error'
import { modelProblem, track } from './analytics'
import type { EventFields } from './analytics'
import { breadcrumb, runtimeReport } from './diagnostics'
import type { Breadcrumb, RuntimeReport } from './diagnostics'
import type { ModelProfile } from './model-profile'

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
let backend: ModelDiagnostics['backend'] = 'unknown'

export const browserModelReady = () => ready

function run<T>(
  message: object,
  progress: Progress,
  signal: AbortSignal,
  onTokens?: (tokens: TokenSpan[]) => void,
  onProfile?: (profile: ModelProfile) => void,
): Promise<T> {
  if (running)
    return Promise.reject(new Error('The local model is already busy.'))
  if (signal.aborted) return Promise.reject(new DOMException('', 'AbortError'))
  if (!worker) {
    backend = 'unknown'
    worker = new Worker(new URL('./model.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  const current = worker
  let lastStage = 'Model worker'
  const started = performance.now()
  const trail: Breadcrumb[] = []
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
      if (data.profile) onProfile?.(data.profile)
      if (MODEL_BACKENDS.includes(data.backend)) backend = data.backend
      if (data.progress) {
        lastStage = data.progress
        breadcrumb(trail, lastStage)
        progress(data.progress, data.fraction)
      } else if (data.tokens) onTokens?.(data.tokens)
      else if (data.error || 'result' in data) {
        finish()
        if (data.error) {
          current.terminate()
          worker = undefined
          ready = false
          reject(
            Object.assign(new Error(data.error), {
              report:
                data.report ??
                runtimeReport(data.error, lastStage, 'model', {
                  trail,
                  elapsedMs: Math.round(performance.now() - started),
                }),
              diagnostics:
                data.diagnostics ??
                modelDiagnostics(data.error, lastStage, backend),
            }),
          )
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
      const diagnostics = modelDiagnostics(event, lastStage, backend)
      if (diagnostics.code === 'runtime') diagnostics.code = 'worker'
      reject(
        Object.assign(new Error(modelError(event, 'Model worker')), {
          diagnostics,
          report: runtimeReport(event, lastStage, 'worker', {
            trail,
            elapsedMs: Math.round(performance.now() - started),
          }),
        }),
      )
    }
    signal.addEventListener('abort', cancel, { once: true })
    current.postMessage(message)
  })
}

function reportFailure(
  cause: unknown,
  stage: string,
  context: EventFields = {},
) {
  const diagnostics =
    (cause as { diagnostics?: ModelDiagnostics } | null)?.diagnostics ??
    modelDiagnostics(cause, stage, backend)
  track('model_error', {
    ...context,
    problem: modelProblem(cause),
    ...diagnostics,
    report:
      (cause as { report?: RuntimeReport } | null)?.report ??
      runtimeReport(cause, stage, 'model'),
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
        else reportFailure(cause, 'Model startup')
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
  onTokens?: (tokens: TokenSpan[]) => void,
  context: EventFields = {},
) {
  let profile: ModelProfile | undefined
  let updated = 0
  const record = (status: ModelProfile['status']) => {
    if (!profile) return
    track('model_profile', {
      ...context,
      backend: profile.backend,
      profile:
        profile.status === 'running'
          ? {
              ...profile,
              status,
              totalMs: profile.totalMs + performance.now() - updated,
            }
          : profile,
    })
  }
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
    onTokens,
    (value) => {
      profile = value
      updated = performance.now()
    },
  )
    .then((result) => {
      record('ok')
      return result
    })
    .catch((cause) => {
      record(
        cause instanceof DOMException && cause.name === 'AbortError'
          ? 'cancelled'
          : 'error',
      )
      if (cause instanceof DOMException && cause.name === 'AbortError')
        track('model_cancel', context)
      else reportFailure(cause, 'Scoring', context)
      throw cause
    })
}
