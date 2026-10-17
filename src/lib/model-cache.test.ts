import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadWeights, saeEncoder } from './model-cache'
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
    put: async (url: string, response: Response) => {
      entries.set(url, response)
    },
  } as unknown as Cache
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

it('reports a real storage failure without redownloading the file', async () => {
  const data = new Uint8Array([1, 2, 3, 4])
  const fetch = vi.fn().mockResolvedValue(new Response(data))
  vi.stubGlobal('fetch', fetch)
  cache.put = async () => {
    throw new DOMException('Full', 'QuotaExceededError')
  }
  await expect(
    downloadWeights(cache, [{ tensors: {}, chunks: [chunk(data)] }], () => {}),
  ).rejects.toThrow('Browser storage is full')
  expect(fetch).toHaveBeenCalledTimes(1)
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
