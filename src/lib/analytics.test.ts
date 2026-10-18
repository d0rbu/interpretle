import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { modelDiagnostics } from './model-error'

const sent = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(null, { status: 204 }),
)
beforeEach(() => {
  vi.resetModules()
  sent.mockReset()
  sent.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', sent)
  vi.stubGlobal('navigator', {
    hardwareConcurrency: 8,
    deviceMemory: 4,
    maxTouchPoints: 5,
  })
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>()
    vi.stubGlobal(name, {
      get length() {
        return values.size
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
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

it('records uncaught errors and promise rejections with context but never reads form values', async () => {
  const target = new EventTarget()
  vi.stubGlobal('window', target)
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }))
  const { startErrorTracking, track } = await import('./analytics')
  startErrorTracking()
  track('writein_open', { mode: 'practice' })
  const error = new TypeError('Cannot read property')
  target.dispatchEvent(
    Object.assign(new Event('error'), {
      message: error.message,
      error,
      filename: 'https://interpretle.com/assets/app.js?private=query',
      lineno: 1,
      colno: 120,
    }),
  )
  target.dispatchEvent(
    Object.assign(new Event('unhandledrejection'), {
      reason: new Error('Async failure'),
    }),
  )
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(3))
  const records = sent.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body)),
  )
  expect(records[1]).toMatchObject({
    event: 'client_error',
    cores: 8,
    report: {
      source: 'window',
      name: 'TypeError',
      message: error.message,
      stack: error.stack,
      filename: 'https://interpretle.com/assets/app.js',
      line: 1,
      column: 120,
      visible: true,
      online: true,
      trail: [expect.objectContaining({ stage: 'writein_open · practice' })],
    },
  })
  expect(records[2]).toMatchObject({
    event: 'client_error',
    report: { source: 'promise', message: 'Async failure' },
  })
  expect(JSON.stringify(records)).not.toContain('private=query')
})

it('persists later events while an earlier request is pending and keeps browser timestamps in submission order', async () => {
  let resolve!: (response: Response) => void
  sent.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const { track } = await import('./analytics')
  track('guess_submit', { text: 'Submitted café.' })
  track('guess', { attempt: 1 })
  await vi.waitFor(() => {
    const keys = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i),
    )
    expect(
      keys.filter((key) => key?.startsWith('interpretle:event:')),
    ).toHaveLength(2)
  })
  expect(sent).toHaveBeenCalledOnce()
  resolve(new Response(null, { status: 204 }))
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
  const bodies = sent.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body)),
  )
  expect(bodies.map((body) => body.sequence)).toEqual([1, 2])
  expect(bodies[0]).toMatchObject({
    event: 'guess_submit',
    text: 'Submitted café.',
  })
  expect(bodies[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(bodies[0].visit).toBe(bodies[1].visit)
  await vi.waitFor(() => expect(localStorage.length).toBe(1))
})

it('retries saved events after a reload without changing their IDs, timestamps, or contents', async () => {
  sent.mockRejectedValueOnce(new TypeError('Offline'))
  const { track } = await import('./analytics')
  track('guess_submit', { text: 'Keep this submitted text.' })
  await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
  const first = JSON.parse(String(sent.mock.calls[0][1]?.body))
  await vi.waitFor(() =>
    expect(localStorage.getItem('interpretle:event:' + first.id)).toBeTruthy(),
  )
  vi.resetModules()
  const next = await import('./analytics')
  next.track('visit')
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(3))
  expect(JSON.parse(String(sent.mock.calls[1][1]?.body))).toEqual(first)
  await vi.waitFor(() =>
    expect(
      localStorage.getItem('interpretle:event:' + first.id),
    ).toBeUndefined(),
  )
})
