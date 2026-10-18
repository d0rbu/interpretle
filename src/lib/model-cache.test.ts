import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  cachedFile,
  downloadWeights,
  pruneModelCache,
  readRanges,
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
  expect(await cachedFile(cache, asset)).toEqual(data)
  expect(await cachedFile(cache, asset)).toEqual(data)
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
  await vi.advanceTimersByTimeAsync(1000)
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

it('updates the remaining-time estimate every second, including while waiting for more bytes', async () => {
  vi.useFakeTimers()
  const data = new Uint8Array(1000).fill(7)
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
  await vi.advanceTimersByTimeAsync(1500)
  expect(progress.mock.calls.at(-1)?.[0]).toContain('Estimating…')
  stream.enqueue(data.subarray(0, 10))
  await vi.advanceTimersByTimeAsync(0)
  expect(progress.mock.calls.at(-1)?.[0]).toContain(' · 02:29')
  await vi.advanceTimersByTimeAsync(500)
  expect(progress.mock.calls.at(-1)?.[0]).toContain(' · 03:18')
  expect(progress.mock.calls.at(-1)?.[1]).toBe(0.01)
  stream.enqueue(data.subarray(10))
  stream.close()
  await downloading
  expect(progress.mock.calls.at(-1)?.[1]).toBe(1)
  expect(progress.mock.calls.at(-1)?.[0]).toMatch(/ MB\/s$/)
  expect(vi.getTimerCount()).toBe(0)
  const count = progress.mock.calls.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(progress).toHaveBeenCalledTimes(count)
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
  await expect(cachedFile(cache, { url: 'file:///' })).rejects.toThrow(
    'HTTP or HTTPS',
  )
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
    ).rejects.toMatchObject({
      name,
      report: {
        name,
        storageOperation: 'CacheStorage.put',
        storageAttempts: 1,
      },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await entries.get(saved)!.text()).toBe('completed model chunk')
  },
)

it('retries Safari filesystem write failures without downloading the same bytes again', async () => {
  const data = new Uint8Array([1, 2, 3])
  const fetch = vi.fn().mockResolvedValue(new Response(data))
  vi.stubGlobal('fetch', fetch)
  const put = cache.put
  let calls = 0
  cache.put = vi.fn(async (...args: Parameters<Cache['put']>) => {
    if (++calls <= 2)
      throw new TypeError(
        calls === 1
          ? 'Internal error'
          : 'Failed writing data to the file system',
      )
    return put(...args)
  })
  expect(await cachedFile(cache, chunk(data))).toEqual(data)
  expect(fetch).toHaveBeenCalledOnce()
  expect(cache.put).toHaveBeenCalledTimes(3)
  expect(new Uint8Array(await [...entries.values()][0].arrayBuffer())).toEqual(
    data,
  )
})

it('serializes browser writes while downloads run concurrently', async () => {
  const data = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(data[Number(url.split('/').at(-1)) - 1]),
    ),
  )
  let active = 0,
    maximum = 0
  const put = cache.put
  cache.put = async (...args) => {
    active++
    maximum = Math.max(maximum, active)
    await Promise.resolve()
    await put(...args)
    active--
  }
  await Promise.all(
    data.map((bytes, i) =>
      cachedFile(cache, { ...chunk(bytes), url: `/model/${i + 1}` }),
    ),
  )
  expect(maximum).toBe(1)
  expect(entries.size).toBe(3)
})

it('bounds storage retries and captures original errors, file size and quota', async () => {
  const data = new Uint8Array([9, 8, 7])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(data)))
  vi.stubGlobal('navigator', {
    storage: {
      estimate: async () => ({ usage: 2300000000, quota: 10000000000 }),
    },
  })
  cache.put = vi.fn().mockRejectedValue(new TypeError('Internal error'))
  await expect(cachedFile(cache, chunk(data))).rejects.toMatchObject({
    name: 'TypeError',
    report: {
      message: 'Internal error',
      stage: 'Saving model download to browser storage',
      storageOperation: 'CacheStorage.put',
      storageAttempts: 3,
      assetBytes: 3,
      storageUsageBytes: 2300000000,
      storageQuotaBytes: 10000000000,
    },
  })
  expect(cache.put).toHaveBeenCalledTimes(3)
})

it('does not retry a Firefox disk-space failure while downloading the tokenizer', async () => {
  const error = new DOMException('', 'NS_ERROR_FILE_NO_DEVICE_SPACE')
  const fetch = vi.fn().mockRejectedValue(error)
  vi.stubGlobal('fetch', fetch)
  await expect(
    cachedFile(cache, { url: '/model/tokenizer.json' }),
  ).rejects.toBe(error)
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
  await expect(
    cachedFile(cache, { url: '/model/tokenizer.json' }),
  ).rejects.toBe(error)
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

it('reads overlapping tensor ranges and split tensors with one read per cached chunk', async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const parts = [chunk(data.subarray(0, 4)), chunk(data.subarray(4), 4)]
  for (const part of parts)
    entries.set(
      `https://interpretle.com/__model_cache/${part.sha256}`,
      new Response(data.slice(part.offset, part.offset + part.bytes)),
    )
  const match = vi.spyOn(cache, 'match')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(
    await readRanges(cache, { tensors: {}, chunks: parts }, [
      { offset: 0, bytes: 4 },
      { offset: 1, bytes: 2 },
      { offset: 3, bytes: 3 },
    ]),
  ).toEqual([data.slice(0, 4), data.slice(1, 3), data.slice(3, 6)])
  expect(match).toHaveBeenCalledTimes(2)
  expect(fetch).not.toHaveBeenCalled()
})

it('fails on missing, incomplete or out-of-range cached weights without fetching them', async () => {
  const data = new Uint8Array([1, 2, 3, 4])
  const part = chunk(data)
  const source = { tensors: {}, chunks: [part] }
  const ranges = [{ offset: 0, bytes: 4 }]
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(readRanges(cache, source, ranges)).rejects.toThrow('cleared')
  const key = `https://interpretle.com/__model_cache/${part.sha256}`
  entries.set(key, new Response(data.subarray(0, 3)))
  await expect(readRanges(cache, source, ranges)).rejects.toThrow('incomplete')
  expect(entries.has(key)).toBe(false)
  entries.set(key, new Response(data))
  await expect(
    readRanges(cache, source, [{ offset: 0, bytes: 5 }]),
  ).rejects.toThrow('outside')
  expect(fetch).not.toHaveBeenCalled()
})

it('resumes a partially saved weight file across preparations without requesting saved pieces', async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const parts = [chunk(data.subarray(0, 4), 100), chunk(data.subarray(4), 200)]
  const asset = { ...chunk(data), parts }
  const sources = [{ tensors: {}, chunks: [asset] }]
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(data.subarray(0, 4)))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  await expect(downloadWeights(cache, sources, () => {})).rejects.toThrow(
    'HTTP 404',
  )
  expect([...entries.keys()]).toEqual([
    `https://interpretle.com/__model_parts/${parts[0].sha256}`,
  ])
  fetch.mockReset().mockResolvedValueOnce(new Response(data.subarray(4)))
  const progress = vi.fn()
  await downloadWeights(cache, sources, progress)
  expect(progress.mock.calls[0][1]).toBe(0.5)
  expect(progress.mock.calls[0][0]).toContain('0.00 MB/s')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0]).toBe(parts[1].url)
  expect([...entries.keys()]).toEqual([
    `https://interpretle.com/__model_cache/${asset.sha256}`,
  ])
  expect(new Uint8Array(await [...entries.values()][0].arrayBuffer())).toEqual(
    data,
  )
  expect(progress.mock.calls.at(-1)?.[1]).toBe(1)
})

it('keeps all pieces if the final cache write fails and completes without more network requests', async () => {
  const data = new Uint8Array([1, 2, 3, 4])
  const asset = {
    ...chunk(data),
    parts: [chunk(data.subarray(0, 2), 100), chunk(data.subarray(2), 200)],
  }
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(data.subarray(0, 2)))
    .mockResolvedValueOnce(new Response(data.subarray(2)))
  vi.stubGlobal('fetch', fetch)
  const put = cache.put
  cache.put = async (...args) => {
    if (String(args[0]).includes('/__model_cache/'))
      throw new DOMException('', 'QuotaExceededError')
    return put(...args)
  }
  const sources = [{ tensors: {}, chunks: [asset] }]
  await expect(downloadWeights(cache, sources, () => {})).rejects.toMatchObject(
    {
      name: 'QuotaExceededError',
    },
  )
  expect(entries.size).toBe(2)
  cache.put = put
  await downloadWeights(cache, sources, () => {})
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(entries.size).toBe(1)
})

it('repairs only a damaged cached piece, keeping valid pieces', async () => {
  const data = new Uint8Array([1, 2, 3, 4])
  const parts = [chunk(data.subarray(0, 2), 100), chunk(data.subarray(2), 200)]
  const asset = { ...chunk(data), parts }
  entries.set(
    `https://interpretle.com/__model_parts/${parts[0].sha256}`,
    new Response('broken'),
  )
  entries.set(
    `https://interpretle.com/__model_parts/${parts[1].sha256}`,
    new Response(data.subarray(2)),
  )
  const fetch = vi.fn().mockResolvedValue(new Response(data.subarray(0, 2)))
  vi.stubGlobal('fetch', fetch)
  expect(await cachedFile(cache, asset)).toEqual(data)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0]).toBe(parts[0].url)
})

it('decompresses independently verified gzip pieces to the exact original tokenizer bytes', async () => {
  const data = new TextEncoder().encode('{"model":{"vocab":["a","b","c"]}}')
  const compressed = new Uint8Array(gzipSync(data))
  const asset = {
    ...chunk(data),
    parts: [
      {
        ...chunk(compressed, 100),
        compression: 'gzip' as const,
        decodedBytes: data.length,
      },
    ],
  }
  const fetch = vi.fn().mockResolvedValue(new Response(compressed))
  vi.stubGlobal('fetch', fetch)
  expect(await cachedFile(cache, asset)).toEqual(data)
  expect(await cachedFile(cache, asset)).toEqual(data)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(entries.size).toBe(1)
})

it('retains current partial downloads when pruning older model files', async () => {
  const data = new Uint8Array([1, 2, 3, 4])
  const asset = { ...chunk(data), parts: [chunk(data.subarray(0, 2), 100)] }
  const current = `https://interpretle.com/__model_parts/${asset.parts[0].sha256}`
  entries.set(current, new Response(data.subarray(0, 2)))
  entries.set(
    'https://interpretle.com/__model_parts/obsolete',
    new Response('old'),
  )
  await pruneModelCache(cache, [{ tensors: {}, chunks: [asset] }], [])
  expect([...entries.keys()]).toEqual([current])
  const complete = `https://interpretle.com/__model_cache/${asset.sha256}`
  entries.set(complete, new Response(data))
  await pruneModelCache(cache, [{ tensors: {}, chunks: [asset] }], [])
  expect([...entries.keys()]).toEqual([complete])
})
