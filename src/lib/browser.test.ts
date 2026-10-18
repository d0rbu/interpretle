import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Catalog } from './types'

vi.mock('./analytics', () => ({ track: vi.fn(), modelProblem: vi.fn() }))

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
  onerror = null
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
