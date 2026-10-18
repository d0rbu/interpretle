import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { modelDiagnostics } from './model-error'

const sent = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(null, { status: 204 }),
)
beforeEach(() => {
  vi.resetModules()
  sent.mockClear()
  vi.stubGlobal('fetch', sent)
  vi.stubGlobal('navigator', {
    hardwareConcurrency: 8,
    deviceMemory: 4,
    maxTouchPoints: 5,
  })
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>()
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    })
  }
})
afterEach(() => vi.unstubAllGlobals())

it('sends safe error categories and reported capabilities without messages or custom text', async () => {
  const { track } = await import('./analytics')
  track('model_error', {
    problem: 'runtime',
    ...modelDiagnostics(
      new Error('Tokenizer rejected PRIVATE CUSTOM TEXT'),
      'Text tokenization',
      'cpu',
    ),
  })
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
  const body = JSON.parse(String(sent.mock.calls[0][1]?.body))
  expect(body).toMatchObject({
    event: 'model_error',
    code: 'tokenizer',
    phase: 'tokenizer',
    backend: 'cpu',
    cores: 8,
    memoryGb: 4,
    touchPoints: 5,
  })
  expect(body).not.toHaveProperty('userAgent')
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|CUSTOM|TEXT|rejected/)
})

it('omits unavailable device capabilities rather than inventing zero values', async () => {
  vi.stubGlobal('navigator', { hardwareConcurrency: 0, maxTouchPoints: 0 })
  const { track } = await import('./analytics')
  track('model_error', { problem: 'network' })
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
  const body = JSON.parse(String(sent.mock.calls[0][1]?.body))
  expect(body).not.toHaveProperty('memoryGb')
  expect(body).not.toHaveProperty('cores')
  expect(body.touchPoints).toBe(0)
})

it('does not collect device capabilities for ordinary gameplay events', async () => {
  vi.stubGlobal('navigator', {
    get deviceMemory() {
      throw new Error('Must not read device memory')
    },
  })
  const { track } = await import('./analytics')
  track('visit')
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
  const body = JSON.parse(String(sent.mock.calls[0][1]?.body))
  expect(body).toMatchObject({ event: 'visit' })
  for (const key of ['cores', 'memoryGb', 'touchPoints'])
    expect(body).not.toHaveProperty(key)
})
