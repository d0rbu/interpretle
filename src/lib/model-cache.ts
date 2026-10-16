export interface TensorInfo {
  shape: number[]
  dtype: string
  offset: number
  bytes: number
}
interface Chunk {
  offset: number
  bytes: number
  sha256: string
}
export interface WeightSource {
  url: string
  tensors: Record<string, TensorInfo>
  chunks: Chunk[]
}

const key = (chunk: Chunk) =>
  new URL(`/__model_cache/${chunk.sha256}`, location.origin).href

export async function verifiedBytes(response: Response, hash?: string) {
  if (!response.ok)
    throw new Error(`Model download failed (${response.status}). Please retry.`)
  const data = new Uint8Array(await response.arrayBuffer())
  if (hash) {
    const digest = await crypto.subtle.digest('SHA-256', data)
    const actual = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
    if (actual !== hash)
      throw new Error(
        'A model download failed its integrity check. Please retry.',
      )
  }
  return data
}

export async function cachedFile(cache: Cache, url: string, hash?: string) {
  const cacheKey = hash
    ? `${new URL(url, location.origin).href}?sha256=${hash}`
    : url
  const saved = await cache.match(cacheKey)
  if (saved) return new Uint8Array(await saved.arrayBuffer())
  const data = await verifiedBytes(
    await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }),
    hash,
  )
  await cache.put(cacheKey, new Response(data))
  return data
}

/** Every required chunk is downloaded before inference. Reads below NEVER
 * fetch missing rows, keeping the player's token IDs out of network requests. */
export async function downloadWeights(
  cache: Cache,
  source: WeightSource,
  progress: (message: string) => void,
) {
  const saved = new Set((await cache.keys()).map((request) => request.url))
  const missing = source.chunks.filter((chunk) => !saved.has(key(chunk)))
  const total = source.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
  let done = total - missing.reduce((sum, chunk) => sum + chunk.bytes, 0)
  // Modern Chrome deliberately caps the reported quota estimate at usage +
  // 10 GiB. It is not the actual limit; handle real storage failures below.
  let cursor = 0,
    failed = false
  const jobs = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      while (cursor < missing.length && !failed) {
        const chunk = missing[cursor++]
        try {
          const response = await fetch(source.url, {
            headers: {
              Range: `bytes=${chunk.offset}-${chunk.offset + chunk.bytes - 1}`,
            },
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          })
          if (response.status !== 206)
            throw new Error(
              'The model host did not honor the partial download. Please retry.',
            )
          const data = await verifiedBytes(response, chunk.sha256)
          if (data.byteLength !== chunk.bytes)
            throw new Error('The model download was incomplete. Please retry.')
          // CacheStorage does not accept HTTP 206; save verified bytes as a local 200 response.
          await cache.put(key(chunk), new Response(data))
          done += data.byteLength
          progress(
            `Downloading model: ${(done / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`,
          )
        } catch (error) {
          failed = true
          if (
            error instanceof DOMException &&
            error.name === 'QuotaExceededError'
          )
            throw new Error(
              'Browser storage is full. Free space and retry to resume the download. No attempt was used.',
            )
          throw error
        }
      }
    }),
  )
  for (const job of jobs) if (job.status === 'rejected') throw job.reason
}

export async function readRange(
  cache: Cache,
  source: WeightSource,
  start: number,
  length: number,
) {
  const result = new Uint8Array(length)
  let copied = 0
  for (const chunk of source.chunks) {
    const from = Math.max(start, chunk.offset),
      to = Math.min(start + length, chunk.offset + chunk.bytes)
    if (to <= from) continue
    const saved = await cache.match(key(chunk))
    if (!saved)
      throw new Error(
        'The browser cleared part of the model cache. Load the model again; no attempt was used.',
      )
    const bytes = new Uint8Array(await saved.arrayBuffer())
    result.set(
      bytes.subarray(from - chunk.offset, to - chunk.offset),
      from - start,
    )
    copied += to - from
  }
  if (copied !== length)
    throw new Error('Model tensor is outside the downloaded weights.')
  return result
}

/** Read only relevant cached chunks, once each, without loading a multi-GB table. */
export async function embeddingRows(
  cache: Cache,
  source: WeightSource,
  tensor: TensorInfo,
  ids: number[],
) {
  const width = tensor.shape[1] * 2
  const result = new Uint8Array(ids.length * width)
  for (const chunk of source.chunks) {
    const rows = ids
      .map((id, index) => ({ start: tensor.offset + id * width, index }))
      .filter(
        (row) =>
          row.start < chunk.offset + chunk.bytes &&
          row.start + width > chunk.offset,
      )
    if (!rows.length) continue
    const saved = await cache.match(key(chunk))
    if (!saved)
      throw new Error(
        'The browser cleared part of the model cache. Load the model again.',
      )
    const bytes = new Uint8Array(await saved.arrayBuffer())
    for (const row of rows) {
      const from = Math.max(row.start, chunk.offset),
        to = Math.min(row.start + width, chunk.offset + chunk.bytes)
      result.set(
        bytes.subarray(from - chunk.offset, to - chunk.offset),
        row.index * width + from - row.start,
      )
    }
  }
  return result
}
