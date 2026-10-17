import { isStorageFull } from './model-error'

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
  url?: string
}
export interface WeightSource {
  url?: string
  tensors: Record<string, TensorInfo>
  chunks: Chunk[]
}

const key = (chunk: Chunk) =>
  new URL(`/__model_cache/${chunk.sha256}`, location.origin).href
const fileKey = (url: string, hash?: string) =>
  hash ? `${new URL(url, location.origin).href}?sha256=${hash}` : url

/** Drop obsolete model versions, retaining every current weight and asset. */
export async function pruneModelCache(
  cache: Cache,
  sources: WeightSource[],
  assets: { url: string; sha256: string }[],
) {
  const keep = new Set([
    ...sources.flatMap((source) => source.chunks.map(key)),
    ...assets.map((asset) => fileKey(asset.url, asset.sha256)),
  ])
  for (const request of await cache.keys())
    if (!keep.has(request.url)) await cache.delete(request.url)
}

class DownloadError extends Error {
  constructor(
    message: string,
    readonly retry = true,
  ) {
    super(message)
  }
}

async function download(
  url: string,
  hash?: string,
  bytes?: number,
  range?: string,
  received?: (bytes: number) => void,
) {
  const file = new URL(url, location.origin)
  if (!['http:', 'https:'].includes(file.protocol))
    throw new Error('The model download URL must use HTTP or HTTPS.')
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout>
    // Slow transfers may take minutes; only a lack of incoming data times out.
    const keepAlive = () => {
      clearTimeout(timeout)
      timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              'No download data arrived for 30 seconds.',
              'TimeoutError',
            ),
          ),
        30000,
      )
    }
    try {
      received?.(0)
      keepAlive()
      const response = await fetch(url, {
        // CacheStorage holds the verified copy; do not also fill the HTTP cache.
        cache: 'no-store',
        headers: range ? { Range: range } : undefined,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status !== (range ? 206 : 200))
        throw new DownloadError(
          `HTTP ${response.status} from ${file.hostname} (${file.pathname.split('/').at(-1)?.slice(0, 16)}).`,
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        )
      keepAlive()
      const data = await verifiedBytes(response, hash, (loaded) => {
        keepAlive()
        received?.(loaded)
      })
      if (bytes !== undefined && data.byteLength !== bytes)
        throw new Error('The downloaded file was incomplete.')
      return data
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error
      if (isStorageFull(cause)) throw cause
      if (attempt === 3 || (cause instanceof DownloadError && !cause.retry))
        throw new Error(
          `Could not download from ${file.hostname}: ${cause instanceof Error ? cause.message : String(cause)} Completed files are saved; retry to resume.`,
        )
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    } finally {
      clearTimeout(timeout!)
    }
  }
}

export async function verifiedBytes(
  response: Response,
  hash?: string,
  received?: (bytes: number) => void,
) {
  if (!response.ok)
    throw new Error(`Model download failed (${response.status}). Please retry.`)
  let loaded = 0
  const body =
    received && response.body
      ? new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, stream) {
                loaded += chunk.byteLength
                received(loaded)
                stream.enqueue(chunk)
              },
            }),
          ),
        )
      : response
  const data = new Uint8Array(await body.arrayBuffer())
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
  const cacheKey = fileKey(url, hash)
  const saved = await cache.match(cacheKey)
  if (saved) {
    try {
      return await verifiedBytes(saved, hash)
    } catch (cause) {
      if (isStorageFull(cause)) throw cause
      // Repair an incomplete/corrupted cached tokenizer or graph automatically.
      await cache.delete(cacheKey)
    }
  }
  const data = await download(url, hash)
  await cache.put(cacheKey, new Response(data))
  return data
}

/** Every required chunk is downloaded before inference. Reads below NEVER
 * fetch missing rows, keeping the player's token IDs out of network requests. */
export async function downloadWeights(
  cache: Cache,
  sources: WeightSource[],
  progress: (message: string, fraction?: number) => void,
) {
  const saved = new Set((await cache.keys()).map((request) => request.url))
  const chunks = [
    ...new Map(
      sources.flatMap((source) =>
        source.chunks.map(
          (chunk) =>
            [
              chunk.sha256,
              {
                ...chunk,
                downloadUrl: chunk.url ?? source.url!,
              },
            ] as const,
        ),
      ),
    ).values(),
  ]
  const missing = chunks.filter((chunk) => !saved.has(key(chunk)))
  const total = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
  let done = total - missing.reduce((sum, chunk) => sum + chunk.bytes, 0)
  const inFlight = new Map<string, number>()
  const started = Date.now()
  let transferred = 0,
    lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < 200) return
    lastReport = now
    const loaded = done + [...inFlight.values()].reduce((sum, n) => sum + n, 0)
    const speed =
      transferred && now > started
        ? ` · ${(transferred / (now - started) / 1000).toFixed(2)} MB/s`
        : ''
    progress(
      `Downloading model: ${(loaded / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB${speed}`,
      total ? Math.min(done < total ? 0.999 : 1, loaded / total) : 1,
    )
  }
  report(true)
  // Quota estimates are approximate; stop on actual storage errors below.
  let cursor = 0,
    failed = false
  const jobs = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      while (cursor < missing.length && !failed) {
        const chunk = missing[cursor++]
        try {
          const data = await download(
            chunk.downloadUrl,
            chunk.sha256,
            chunk.bytes,
            chunk.url
              ? undefined
              : `bytes=${chunk.offset}-${chunk.offset + chunk.bytes - 1}`,
            (loaded) => {
              transferred += Math.max(
                0,
                loaded - (inFlight.get(chunk.sha256) ?? 0),
              )
              inFlight.set(chunk.sha256, loaded)
              report()
            },
          )
          // CacheStorage does not accept HTTP 206; save verified bytes as a local 200 response.
          await cache.put(key(chunk), new Response(data))
          inFlight.delete(chunk.sha256)
          done += data.byteLength
          report(true)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  for (const job of jobs) if (job.status === 'rejected') throw job.reason
}

/** Full encoder is cached once; read only this feature's FP32 row into memory. */
export async function saeEncoder(
  cache: Cache,
  source: WeightSource,
  index: number,
) {
  const matrix = source.tensors.W_enc
  if (!Number.isInteger(index) || index < 0 || index >= matrix.shape[0])
    throw new Error('This SAE feature is outside the downloaded dictionary.')
  const width = matrix.shape[1]
  const parts = await Promise.all([
    readRange(cache, source, matrix.offset + index * width * 4, width * 4),
    readRange(cache, source, source.tensors.b_enc.offset + index * 4, 4),
    readRange(cache, source, source.tensors.threshold.offset + index * 4, 4),
  ])
  return {
    weight: new Float32Array(parts[0].buffer),
    bias: new DataView(parts[1].buffer).getFloat32(0, true),
    threshold: new DataView(parts[2].buffer).getFloat32(0, true),
  }
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
  const width = tensor.shape[1] * (tensor.dtype === 'FP4' ? 18 / 32 : 2)
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
