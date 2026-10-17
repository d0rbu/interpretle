import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  cachedFile,
  downloadWeights,
  pruneModelCache,
  saeEncoder,
} from './model-cache'
import type { WeightSource } from './model-cache'

let entries: Map<string, Response>
let cache: Cache
const chunk = (data: Uint8Array, offset = 0) => ({
  offset,
  bytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex'),
  url: `/model/weights/${offset}.bin`,
})
beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://interpretle.com' })
  entries = new Map()
  cache = {
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    match: async (url: string) => entries.get(url)?.clone(),
    delete: async (url: string) => entries.delete(url),
    put: async (url: string, response: Response) => {
      entries.set(url, response)
    },
  } as unknown as Cache
})

it('repairs a damaged cached tokenizer and validates it before reuse', async () => {
  const data = new TextEncoder().encode('{"model":{}}')
  const asset = chunk(data)
  const key = `https://interpretle.com${asset.url}?sha256=${asset.sha256}`
  entries.set(key, new Response('damaged cached tokenizer'))
  const fetch = vi.fn().mockResolvedValue(new Response(data))
  vi.stubGlobal('fetch', fetch)
  expect(await cachedFile(cache, asset.url, asset.sha256)).toEqual(data)
  expect(await cachedFile(cache, asset.url, asset.sha256)).toEqual(data)
  expect(fetch).toHaveBeenCalledTimes(1)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('removes obsolete model files while retaining shared weights, the full SAE and current assets', async () => {
  const model = chunk(new Uint8Array([1, 2, 3]))
  const sae = chunk(new Uint8Array([4, 5, 6]), 3)
  const assets = [
    { url: '/model/tokenizer.json', sha256: 'current-tokenizer' },
    { url: '/model/cpu.onnx', sha256: 'current-cpu-graph' },
    { url: '/model/gpu.onnx', sha256: 'current-gpu-graph' },
  ]
  const current = [
    ...[model, sae].map(
      (part) => `https://interpretle.com/__model_cache/${part.sha256}`,
    ),
    ...assets.map(
      (asset) => `https://interpretle.com${asset.url}?sha256=${asset.sha256}`,
    ),
  ]
  for (const url of [
    ...current,
    'https://interpretle.com/__model_cache/old-fp16-weights',
    'https://interpretle.com/model/tokenizer.json?sha256=old-tokenizer',
    'https://huggingface.co/old-tokenizer.json?sha256=old-tokenizer',
  ])
    entries.set(url, new Response('cached'))
  const sources = [
    { tensors: {}, chunks: [model, model] },
    { tensors: {}, chunks: [sae] },
  ]
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await pruneModelCache(cache, sources, assets)
  expect([...entries.keys()].sort()).toEqual(current.sort())
  await pruneModelCache(cache, sources, assets)
  await downloadWeights(cache, sources, () => {})
  expect(fetch).not.toHaveBeenCalled()
})

it('retries a transient failure, caches both sources, and resumes without downloading completed files', async () => {
  vi.useFakeTimers()
  const data = new Uint8Array([1, 2, 3, 4])
  const other = new Uint8Array([5, 6, 7, 8])
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockImplementation(
      async (url: string) => new Response(url.includes('/0.') ? data : other),
    )
  vi.stubGlobal('fetch', fetch)
  const sources = [
    { tensors: {}, chunks: [chunk(data)] },
    { tensors: {}, chunks: [chunk(other, 4), chunk(other, 4)] },
  ]
  const progress = vi.fn()
  const downloading = downloadWeights(cache, sources, progress)
  await vi.runAllTimersAsync()
  await downloading
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(entries.size).toBe(2)
  expect(progress.mock.calls.at(-1)?.[1]).toBe(1)
  await downloadWeights(cache, sources, progress)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(
    fetch.mock.calls.every(([, options]) => options.headers === undefined),
  ).toBe(true)
  expect(
    fetch.mock.calls.every(([, options]) => options.cache === 'no-store'),
  ).toBe(true)
})

it('does not cache damaged bytes, and does not retry a missing static file', async () => {
  const data = new Uint8Array([1, 2, 3, 4])
  const source = { tensors: {}, chunks: [chunk(data)] }
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(new Uint8Array([9, 9, 9, 9])))
    .mockResolvedValueOnce(new Response(data))
  vi.stubGlobal('fetch', fetch)
  const downloading = downloadWeights(cache, [source], () => {})
  await downloading
  expect(entries.size).toBe(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  entries.clear()
  fetch.mockReset().mockResolvedValue(new Response(null, { status: 404 }))
  await expect(downloadWeights(cache, [source], () => {})).rejects.toThrow(
    'HTTP 404',
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(entries.size).toBe(0)
})

it('reports incoming bytes before a file is complete without caching unverified data', async () => {
  vi.useFakeTimers()
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  let stream!: ReadableStreamDefaultController<Uint8Array>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          },
        }),
      ),
    ),
  )
  const progress = vi.fn()
  const downloading = downloadWeights(
    cache,
    [{ tensors: {}, chunks: [chunk(data)] }],
    progress,
  )
  await vi.advanceTimersByTimeAsync(250)
  stream.enqueue(data.subarray(0, 4))
  await vi.advanceTimersByTimeAsync(1)
  expect(progress.mock.calls.at(-1)?.[1]).toBe(0.5)
  expect(progress.mock.calls.at(-1)?.[0]).toContain('MB/s')
  expect(entries.size).toBe(0)
  stream.enqueue(data.subarray(4))
  stream.close()
  await downloading
  expect(progress.mock.calls.at(-1)?.[1]).toBe(1)
  expect(entries.size).toBe(1)
})

it('keeps a slow download alive beyond five minutes while bytes keep arriving', async () => {
  vi.useFakeTimers()
  const data = new Uint8Array(20).fill(7)
  let stream!: ReadableStreamDefaultController<Uint8Array>
  let signal!: AbortSignal
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    signal = options.signal
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
          signal.addEventListener('abort', () =>
            controller.error(signal.reason),
          )
        },
      }),
    )
  })
  vi.stubGlobal('fetch', fetch)
  const downloading = downloadWeights(
    cache,
    [{ tensors: {}, chunks: [chunk(data)] }],
    () => {},
  )
  for (const byte of data) {
    await vi.advanceTimersByTimeAsync(20000)
    expect(signal.aborted).toBe(false)
    stream.enqueue(new Uint8Array([byte]))
    await vi.advanceTimersByTimeAsync(1)
  }
  stream.close()
  await downloading
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(entries.size).toBe(1)
})

it('retries a stalled response instead of leaving the bar frozen for five minutes', async () => {
  vi.useFakeTimers()
  const data = new Uint8Array([1, 2, 3, 4])
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      async (_url, { signal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(data.subarray(0, 2))
              signal.addEventListener('abort', () =>
                controller.error(signal.reason),
              )
            },
          }),
        ),
    )
    .mockResolvedValue(new Response(data))
  vi.stubGlobal('fetch', fetch)
  const progress = vi.fn()
  const downloading = downloadWeights(
    cache,
    [{ tensors: {}, chunks: [chunk(data)] }],
    progress,
  )
  await vi.advanceTimersByTimeAsync(31000)
  await downloading
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(progress.mock.calls.at(-1)?.[1]).toBe(1)
  expect(entries.size).toBe(1)
})

it('rejects local-file URLs without asking the browser to access them', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(cachedFile(cache, 'file:///')).rejects.toThrow('HTTP or HTTPS')
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['QuotaExceededError', 'NS_ERROR_FILE_NO_DEVICE_SPACE'])(
  'preserves completed files on %s without retrying a failed write',
  async (name) => {
    const data = new Uint8Array([1, 2, 3, 4])
    const saved = 'https://interpretle.com/__model_cache/completed-file'
    entries.set(saved, new Response('completed model chunk'))
    const fetch = vi.fn().mockResolvedValue(new Response(data))
    vi.stubGlobal('fetch', fetch)
    const error = new DOMException('', name)
    cache.put = async () => {
      throw error
    }
    await expect(
      downloadWeights(
        cache,
        [{ tensors: {}, chunks: [chunk(data)] }],
        () => {},
      ),
    ).rejects.toBe(error)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await entries.get(saved)!.text()).toBe('completed model chunk')
  },
)

it('does not retry a Firefox disk-space failure while downloading the tokenizer', async () => {
  const error = new DOMException('', 'NS_ERROR_FILE_NO_DEVICE_SPACE')
  const fetch = vi.fn().mockRejectedValue(error)
  vi.stubGlobal('fetch', fetch)
  await expect(cachedFile(cache, '/model/tokenizer.json')).rejects.toBe(error)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('does not mistake a storage read failure for a corrupt cached tokenizer', async () => {
  const error = new DOMException('', 'NS_ERROR_FILE_NO_DEVICE_SPACE')
  const saved = new Response('valid cached tokenizer')
  saved.arrayBuffer = async () => {
    throw error
  }
  cache.match = vi.fn().mockResolvedValue(saved)
  cache.delete = vi.fn()
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(cachedFile(cache, '/model/tokenizer.json')).rejects.toBe(error)
  expect(cache.delete).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('reads the last of all 65,536 encoder features entirely from cache', async () => {
  const encoder = new Float32Array(65536 * 2)
  encoder.set([1.25, -2.5], 65535 * 2)
  const bias = new Float32Array(65536)
  bias[65535] = 3.5
  const threshold = new Float32Array(65536)
  threshold[65535] = 4.75
  let offset = 0
  const source: WeightSource = { tensors: {}, chunks: [] }
  for (const [name, values] of Object.entries({
    W_enc: encoder,
    b_enc: bias,
    threshold,
  })) {
    const data = new Uint8Array(values.buffer)
    const row = chunk(data, offset)
    source.tensors[name] = {
      offset,
      bytes: data.length,
      dtype: 'F32',
      shape: name === 'W_enc' ? [65536, 2] : [65536],
    }
    source.chunks.push(row)
    entries.set(
      `https://interpretle.com/__model_cache/${row.sha256}`,
      new Response(data),
    )
    offset += data.length
  }
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const last = await saeEncoder(cache, source, 65535)
  expect([...last.weight]).toEqual([1.25, -2.5])
  expect(last.bias).toBe(3.5)
  expect(last.threshold).toBe(4.75)
  expect(fetch).not.toHaveBeenCalled()
  await expect(saeEncoder(cache, source, 65536)).rejects.toThrow('outside')
})
