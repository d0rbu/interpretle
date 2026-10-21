import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Catalog } from './types'
import { feature } from '../../tests/fixture'
import { profileFixture } from '../../tests/profile-fixture'

const telemetry = vi.hoisted(() => ({
  track: vi.fn(),
  modelProblem: vi.fn(() => 'runtime'),
}))
vi.mock('./analytics', () => telemetry)

const model: NonNullable<Catalog['browserModel']> = {
  manifest: '/model/test.json',
  bytes: 100,
}
let document: EventTarget & { hidden: boolean }
let window: EventTarget
let navigator: { onLine: boolean }
let workers: TestWorker[]
class TestWorker {
  onmessage: ((event: { data: object }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    workers.push(this)
  }
  complete() {
    this.onmessage?.({ data: { result: null } })
  }
}
beforeEach(() => {
  vi.resetModules()
  telemetry.track.mockClear()
  document = Object.assign(new EventTarget(), { hidden: false })
  window = new EventTarget()
  navigator = { onLine: true }
  workers = []
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('navigator', navigator)
  vi.stubGlobal('Worker', TestWorker)
})
afterEach(() => vi.unstubAllGlobals())

it('cancels before preparation starts without creating a worker', async () => {
  const { prepareBrowserModel } = await import('./browser')
  const controller = new AbortController()
  const preparation = prepareBrowserModel(model, () => {}, controller.signal)
  controller.abort()
  await expect(preparation).rejects.toMatchObject({ name: 'AbortError' })
  expect(workers).toHaveLength(0)
})

it('keeps preparation pending through sleep and restarts on wake without reporting an error', async () => {
  const { prepareBrowserModel, browserModelReady } = await import('./browser')
  const progress = vi.fn()
  const preparation = prepareBrowserModel(
    model,
    progress,
    new AbortController().signal,
  )
  let finished = false
  void preparation.then(() => {
    finished = true
  })
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.waitFor(() => expect(workers[0].terminate).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  expect(browserModelReady()).toBe(false)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  workers[1].complete()
  await preparation
  expect(browserModelReady()).toBe(true)
  expect(
    telemetry.track.mock.calls.some(([event]) => event === 'model_error'),
  ).toBe(false)
})

it('waits for a connection and allows cancellation while offline without restarting', async () => {
  const { prepareBrowserModel } = await import('./browser')
  const controller = new AbortController()
  navigator.onLine = false
  const preparation = prepareBrowserModel(model, () => {}, controller.signal)
  const rejected = expect(preparation).rejects.toMatchObject({
    name: 'AbortError',
  })
  await Promise.resolve()
  expect(workers).toHaveLength(0)
  controller.abort()
  await rejected
  navigator.onLine = true
  window.dispatchEvent(new Event('online'))
  await Promise.resolve()
  expect(workers).toHaveLength(0)
})

const cacheReset = {
  error: 'The browser could not save the model files.',
  diagnostics: {
    code: 'storage_unavailable',
    phase: 'storage',
    backend: 'cpu',
  },
  report: {
    source: 'model',
    name: 'NotFoundError',
    message: "Failed to execute 'put' on 'Cache': Entry was not found.",
    stage: 'Saving model download to browser storage',
    release: 'test-build',
    storageOperation: 'CacheStorage.put',
  },
}

it('reopens model storage in a fresh worker after a cleared cache, retaining the original report', async () => {
  const { prepareBrowserModel, browserModelReady } = await import('./browser')
  const preparation = prepareBrowserModel(
    model,
    () => {},
    new AbortController().signal,
  )
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  workers[0].onmessage?.({ data: cacheReset })
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  expect(workers[1].postMessage).toHaveBeenCalledWith({
    type: 'prepare',
    manifest: model.manifest,
  })
  workers[1].complete()
  await preparation
  expect(browserModelReady()).toBe(true)
  const failures = telemetry.track.mock.calls.filter(
    ([event]) => event === 'model_error',
  )
  expect(failures).toEqual([
    ['model_error', expect.objectContaining({ report: cacheReset.report })],
  ])
  expect(telemetry.track).toHaveBeenCalledWith('model_ready')
})

it('stops after one cache-reset retry instead of looping on broken storage', async () => {
  const { prepareBrowserModel, browserModelReady } = await import('./browser')
  const preparation = prepareBrowserModel(
    model,
    () => {},
    new AbortController().signal,
  )
  const rejected = expect(preparation).rejects.toThrow(cacheReset.error)
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  workers[0].onmessage?.({ data: cacheReset })
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  workers[1].onmessage?.({ data: cacheReset })
  await rejected
  expect(workers).toHaveLength(2)
  expect(browserModelReady()).toBe(false)
  expect(telemetry.track).not.toHaveBeenCalledWith('model_ready')
  expect(
    telemetry.track.mock.calls.filter(([event]) => event === 'model_error'),
  ).toHaveLength(2)
})

it.each(['QuotaExceededError', 'TypeError'])(
  'does not restart preparation for other storage errors: %s',
  async (name) => {
    const { prepareBrowserModel } = await import('./browser')
    const preparation = prepareBrowserModel(
      model,
      () => {},
      new AbortController().signal,
    )
    const rejected = expect(preparation).rejects.toThrow(cacheReset.error)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    workers[0].onmessage?.({
      data: { ...cacheReset, report: { ...cacheReset.report, name } },
    })
    await rejected
    expect(workers).toHaveLength(1)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  },
)

it('resumes a disconnected download but does not resume after the user cancels it', async () => {
  const { prepareBrowserModel } = await import('./browser')
  const controller = new AbortController()
  const preparation = prepareBrowserModel(model, () => {}, controller.signal)
  const rejected = expect(preparation).rejects.toMatchObject({
    name: 'AbortError',
  })
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  navigator.onLine = false
  window.dispatchEvent(new Event('offline'))
  await vi.waitFor(() => expect(workers[0].terminate).toHaveBeenCalledOnce())
  navigator.onLine = true
  window.dispatchEvent(new Event('online'))
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  controller.abort()
  await rejected
  expect(workers[1].terminate).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event('online'))
  await Promise.resolve()
  expect(workers).toHaveLength(2)
})

it('reports token boundaries without finishing scoring or claiming activations', async () => {
  const { scoreInBrowser, browserModelReady } = await import('./browser')
  const onTokens = vi.fn()
  const progress = vi.fn()
  const result = scoreInBrowser(
    'A café.',
    feature,
    model,
    progress,
    new AbortController().signal,
    onTokens,
  )
  const tokens = [
    { id: 1, start: 0, end: 1 },
    { id: 2, start: 1, end: 6 },
    { id: 3, start: 6, end: 7 },
  ]
  workers[0].onmessage?.({ data: { tokens } })
  expect(onTokens).toHaveBeenCalledExactlyOnceWith(tokens)
  expect(workers[0].onmessage).not.toBeNull()
  expect(browserModelReady()).toBe(false)
  workers[0].onmessage?.({
    data: { progress: 'Scoring: GPU · Layer 1/22…', fraction: 0.1 },
  })
  expect(progress).toHaveBeenCalledWith('Scoring: GPU · Layer 1/22…', 0.1)
  const scored = tokens.map((token) => ({ ...token, activation: 2 }))
  workers[0].onmessage?.({ data: { result: scored } })
  await expect(result).resolves.toEqual(scored)
  expect(browserModelReady()).toBe(true)
})

it('preserves the original worker exception separately from the displayed recovery message', async () => {
  const { prepareBrowserModel } = await import('./browser')
  const preparation = prepareBrowserModel(
    model,
    () => {},
    new AbortController().signal,
  )
  const rejected = expect(preparation).rejects.toThrow('PRIVATE PATH')
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  workers[0].onmessage?.({
    data: {
      error: 'Tokenizer download failed at PRIVATE PATH',
      diagnostics: {
        code: 'http',
        phase: 'tokenizer',
        backend: 'unknown',
        httpStatus: 503,
      },
      report: {
        source: 'weights',
        name: 'TypeError',
        message: 'Original cache failure',
        stack:
          'TypeError: Original cache failure\n    at readWeights (model.js:1:50)',
        stage: 'Reading layer 4 weights',
        release: 'test-build',
      },
    },
  })
  await rejected
  expect(telemetry.track).toHaveBeenCalledWith('model_error', {
    problem: 'runtime',
    code: 'http',
    phase: 'tokenizer',
    backend: 'unknown',
    httpStatus: 503,
    report: expect.objectContaining({
      source: 'weights',
      message: 'Original cache failure',
      stack: expect.stringContaining('readWeights'),
      stage: 'Reading layer 4 weights',
      release: 'test-build',
    }),
  })
  expect(JSON.stringify(telemetry.track.mock.calls)).not.toContain(
    'PRIVATE PATH',
  )
})

it('identifies a crashed worker using its last execution backend and layer', async () => {
  const { scoreInBrowser } = await import('./browser')
  const result = scoreInBrowser(
    'PRIVATE INPUT',
    feature,
    model,
    () => {},
    new AbortController().signal,
  )
  const rejected = expect(result).rejects.toThrow('GPU device was lost')
  workers[0].onmessage?.({
    data: { progress: 'Scoring: GPU · Layer 7/22 attention', backend: 'gpu' },
  })
  workers[0].onerror?.({ message: 'GPU device was lost' })
  await rejected
  expect(telemetry.track).toHaveBeenCalledWith('model_error', {
    problem: 'runtime',
    code: 'gpu_lost',
    phase: 'inference',
    backend: 'gpu',
    layer: 7,
    report: expect.objectContaining({
      source: 'worker',
      message: 'GPU device was lost',
      stage: 'Scoring: GPU · Layer 7/22 attention',
      trail: [
        expect.objectContaining({
          stage: 'Scoring: GPU · Layer 7/22 attention',
        }),
      ],
    }),
  })
  expect(JSON.stringify(telemetry.track.mock.calls)).not.toContain(
    'PRIVATE INPUT',
  )
})

it('records one private profile linked to the write-in submission without sending its text again', async () => {
  const { scoreInBrowser } = await import('./browser')
  const context = {
    mode: 'daily' as const,
    round: '2026-10-18',
    feature: feature.id,
    submission: crypto.randomUUID(),
    attempt: 2,
  }
  const result = scoreInBrowser(
    'PRIVATE INPUT',
    feature,
    model,
    () => {},
    new AbortController().signal,
    undefined,
    context,
  )
  const profile = profileFixture()
  workers[0].onmessage?.({
    data: { profile: { ...profile, status: 'running' } },
  })
  expect(workers[0].onmessage).not.toBeNull()
  expect(telemetry.track).not.toHaveBeenCalled()
  workers[0].onmessage?.({ data: { result: [], profile } })
  await expect(result).resolves.toEqual([])
  expect(telemetry.track).toHaveBeenCalledExactlyOnceWith('model_profile', {
    ...context,
    backend: 'gpu',
    profile,
  })
  expect(JSON.stringify(telemetry.track.mock.calls)).not.toContain(
    'PRIVATE INPUT',
  )
})

it.each(['cancelled', 'error'])(
  'retains the last partial trace when scoring is %s',
  async (status) => {
    const { scoreInBrowser } = await import('./browser')
    const controller = new AbortController()
    const result = scoreInBrowser(
      'A sentence',
      feature,
      model,
      () => {},
      controller.signal,
    )
    const rejected = expect(result).rejects.toThrow()
    workers[0].onmessage?.({
      data: { profile: profileFixture({ status: 'running' }) },
    })
    if (status === 'cancelled') controller.abort()
    else workers[0].onerror?.({ message: 'GPU device was lost' })
    await rejected
    const profiles = telemetry.track.mock.calls.filter(
      ([event]) => event === 'model_profile',
    )
    expect(profiles).toHaveLength(1)
    expect(profiles[0][1]).toMatchObject({
      profile: { status, steps: profileFixture().steps },
    })
    expect(profiles[0][1].profile.totalMs).toBeGreaterThanOrEqual(2000)
  },
)
