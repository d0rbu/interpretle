import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ readRanges: vi.fn(), embeddingRows: vi.fn() }))
vi.mock('./model-cache', () => io)

let worker: {
  onmessage?: (event: { data: object }) => Promise<void>
  postMessage: ReturnType<typeof vi.fn>
}
beforeEach(() => {
  vi.resetModules()
  io.readRanges.mockReset()
  io.embeddingRows.mockReset()
  worker = { postMessage: vi.fn() }
  vi.stubGlobal('self', worker)
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({}) })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([false, true])(
  'times cache reads separately and transfers expanded weights (CPU %s)',
  async (cpu) => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const half = new Uint16Array([0x3c00, 0x4000])
    io.readRanges.mockImplementation(async () => {
      now += 12
      return [new Uint8Array(half.buffer)]
    })
    await import('./model-weights.worker')
    await worker.onmessage?.({
      data: {
        source: {},
        cpu,
        weights: { test: { shape: [2], dtype: 'F16', offset: 0, bytes: 4 } },
        stage: 'Reading layer 1 weights',
      },
    })
    const [message, transfer] = worker.postMessage.mock.calls[0]
    expect(message.timing).toEqual({
      readMs: 12,
      decodeMs: 0,
      bytes: cpu ? 8 : 4,
    })
    expect(message.weights[0].data).toEqual(
      cpu ? new Float32Array([1, 2]) : half,
    )
    expect(transfer.transfer).toEqual([message.weights[0].data.buffer])
  },
)

it('keeps the original read failure and measured time in a failed weight job', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  io.readRanges.mockImplementation(async () => {
    now += 5
    throw new TypeError('Cache read failed')
  })
  await import('./model-weights.worker')
  await worker.onmessage?.({
    data: { source: {}, weights: {}, stage: 'Reading layer 4 weights' },
  })
  expect(worker.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      timing: { readMs: 5, decodeMs: 0, bytes: 0 },
      report: expect.objectContaining({
        name: 'TypeError',
        message: 'Cache read failed',
        stage: 'Reading layer 4 weights',
      }),
    }),
  )
})
