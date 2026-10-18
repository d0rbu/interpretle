import { isStorageFull } from './model-error'
import { runtimeReport } from './diagnostics'

// Keep downloads parallel, but avoid concurrent CacheStorage writes on iOS.
// Retry transient filesystem failures using the bytes already in memory.
let writes = Promise.resolve()
function cacheWrite(cache: Cache, url: string, bytes: Uint8Array<ArrayBuffer>) {
  const write = writes.then(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await cache.put(url, new Response(bytes))
        return
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (
          attempt < 3 &&
          !isStorageFull(cause) &&
          /internal error|failed writing data|invalidstateerror/i.test(message)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
          continue
        }
        let estimate: StorageEstimate = {}
        try {
          estimate = (await navigator.storage?.estimate()) ?? {}
        } catch {
          /* Storage diagnostics cannot mask the original failure. */
        }
        const report = runtimeReport(
          cause,
          'Saving model download to browser storage',
          'model',
          {
            storageOperation: 'CacheStorage.put',
            asset: new URL(url, location.origin).pathname,
            assetBytes: bytes.byteLength,
            storageAttempts: attempt,
            ...(Number.isFinite(estimate.usage)
              ? { storageUsageBytes: estimate.usage }
              : {}),
            ...(Number.isFinite(estimate.quota)
              ? { storageQuotaBytes: estimate.quota }
              : {}),
          },
        )
        throw Object.assign(new Error(message, { cause }), {
          name: report.name,
          report,
        })
      }
    }
  })
  writes = write.catch(() => {})
  return write
}

export interface TensorInfo {
  shape: number[]
  dtype: string
  offset: number
  bytes: number
}
export interface DownloadPart {
  url: string
  sha256: string
  bytes: number
  compression?: 'gzip'
  decodedBytes?: number
}
export interface ModelAsset {
  url: string
  sha256?: string
  bytes?: number
  parts?: DownloadPart[]
}
interface Chunk {
  offset: number
  bytes: number
  sha256: string
  url?: string
  parts?: DownloadPart[]
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
const partKey = (part: DownloadPart) =>
  new URL(`/__model_parts/${part.sha256}`, location.origin).href
const decodedSize = (part: DownloadPart) => part.decodedBytes ?? part.bytes

/** Drop obsolete model versions, retaining every current weight and asset. */
export async function pruneModelCache(
  cache: Cache,
  sources: WeightSource[],
  assets: ModelAsset[],
) {
  const requests = await cache.keys()
  const saved = new Set(requests.map((request) => request.url))
  const files = [
    ...sources.flatMap((source) =>
      source.chunks.map((chunk) => ({
        cacheKey: key(chunk),
        parts: chunk.parts,
      })),
    ),
    ...assets.map((asset) => ({
      cacheKey: fileKey(asset.url, asset.sha256),
      parts: asset.parts,
    })),
  ]
  const keep = new Set(
    files.flatMap(({ cacheKey, parts }) => [
      cacheKey,
      ...(saved.has(cacheKey) ? [] : (parts?.map(partKey) ?? [])),
    ]),
  )
  for (const request of requests)
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
  received?: (bytes: number, transferred: number) => void,
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
      received?.(0, 0)
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
      let previous = 0
      const data = await verifiedBytes(response, hash, (loaded) => {
        keepAlive()
        received?.(loaded, loaded - previous)
        previous = loaded
      })
      if (bytes !== undefined && data.byteLength !== bytes)
        throw new Error('The downloaded file was incomplete.')
      return data
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error
      if (isStorageFull(cause)) throw cause
      if (attempt === 3 || (cause instanceof DownloadError && !cause.retry))
        throw new Error(
          `Could not download from ${file.hostname}: ${cause instanceof Error ? cause.message : String(cause)} Downloaded pieces are saved; retry to resume.`,
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

/** Persist each small, verified piece before starting the next. No unload
 * handler or HTTP Range support is needed to resume after Safari is suspended. */
async function downloadAsset(
  cache: Cache,
  asset: ModelAsset,
  range?: string,
  received?: (bytes: number, transferred: number) => void,
) {
  const parts = asset.parts
  if (
    !parts?.length ||
    (parts.some((part) => part.compression) &&
      typeof DecompressionStream === 'undefined')
  )
    return download(asset.url, asset.sha256, asset.bytes, range, received)

  const data = new Uint8Array(
    parts.reduce((sum, part) => sum + decodedSize(part), 0),
  )
  if (asset.bytes !== undefined && data.length !== asset.bytes)
    throw new Error('The download manifest has an incorrect file size.')
  const missing: { part: DownloadPart; offset: number }[] = []
  let offset = 0,
    completed = 0
  const copy = async (
    part: DownloadPart,
    bytes: Uint8Array<ArrayBuffer>,
    at: number,
  ) => {
    const decoded = part.compression
      ? new Uint8Array(
          await new Response(
            new Response(bytes).body!.pipeThrough(
              new DecompressionStream('gzip'),
            ),
          ).arrayBuffer(),
        )
      : bytes
    if (decoded.length !== decodedSize(part))
      throw new Error('A model download piece was incomplete.')
    data.set(decoded, at)
    completed += decoded.length
  }
  for (const part of parts) {
    const saved = await cache.match(partKey(part))
    let valid = false
    if (saved) {
      try {
        await copy(part, await verifiedBytes(saved, part.sha256), offset)
        valid = true
      } catch (cause) {
        if (isStorageFull(cause)) throw cause
        await cache.delete(partKey(part))
      }
    }
    if (!valid) missing.push({ part, offset })
    offset += decodedSize(part)
  }
  received?.(completed, 0)
  for (const { part, offset: at } of missing) {
    const bytes = await download(
      part.url,
      part.sha256,
      part.bytes,
      undefined,
      (loaded, transferred) =>
        received?.(
          completed + (loaded / part.bytes) * decodedSize(part),
          transferred,
        ),
    )
    await cacheWrite(cache, partKey(part), bytes)
    await copy(part, bytes, at)
    received?.(completed, 0)
  }
  // The original file hash remains the authority, including for compressed pieces.
  return verifiedBytes(new Response(data), asset.sha256)
}

async function removeParts(cache: Cache, asset: { parts?: DownloadPart[] }) {
  for (const part of asset.parts ?? []) await cache.delete(partKey(part))
}

export async function cachedFile(cache: Cache, asset: ModelAsset) {
  const cacheKey = fileKey(asset.url, asset.sha256)
  const saved = await cache.match(cacheKey)
  if (saved) {
    try {
      return await verifiedBytes(saved, asset.sha256)
    } catch (cause) {
      if (isStorageFull(cause)) throw cause
      // Repair an incomplete/corrupted cached tokenizer or graph automatically.
      await cache.delete(cacheKey)
    }
  }
  const data = await downloadAsset(cache, asset)
  await cacheWrite(cache, cacheKey, data)
  await removeParts(cache, asset)
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
  const inFlight = new Map(
    missing.map((chunk) => [
      chunk.sha256,
      (chunk.parts ?? []).reduce(
        (sum, part) => sum + (saved.has(partKey(part)) ? decodedSize(part) : 0),
        0,
      ),
    ]),
  )
  const started = Date.now()
  let transferred = 0,
    lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < 200) return
    lastReport = now
    const loaded = done + [...inFlight.values()].reduce((sum, n) => sum + n, 0)
    const rate = now > started ? transferred / ((now - started) / 1000) : 0
    const remaining = Math.max(0, total - loaded)
    let estimate = remaining ? ' · Estimating…' : ''
    if (remaining && rate) {
      const seconds = Math.ceil(remaining / rate)
      const minutes = Math.floor(seconds / 60)
      const hours = Math.floor(minutes / 60)
      const mm = String(minutes % 60).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      const time = hours
        ? `${String(hours).padStart(2, '0')}:${mm}:${ss}`
        : minutes
          ? `${mm}:${ss}`
          : `${seconds}s`
      estimate = ` · ${time}`
    }
    progress(
      `Downloading model: ${(loaded / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB · ${(rate / 1e6).toFixed(2)} MB/s${estimate}`,
      total ? Math.min(done < total ? 0.999 : 1, loaded / total) : 1,
    )
  }
  report(true)
  // Quota estimates are approximate; stop on actual storage errors below.
  let cursor = 0,
    failed = false
  const refresh = setInterval(() => report(true), 1000)
  const jobs = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      while (cursor < missing.length && !failed) {
        const chunk = missing[cursor++]
        try {
          const data = await downloadAsset(
            cache,
            { ...chunk, url: chunk.downloadUrl },
            chunk.url
              ? undefined
              : `bytes=${chunk.offset}-${chunk.offset + chunk.bytes - 1}`,
            (loaded, received) => {
              transferred += received
              inFlight.set(chunk.sha256, loaded)
              report()
            },
          )
          // CacheStorage does not accept HTTP 206; save verified bytes as a local 200 response.
          await cacheWrite(cache, key(chunk), data)
          await removeParts(cache, chunk)
          inFlight.delete(chunk.sha256)
          done += data.byteLength
          report(true)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  ).finally(() => clearInterval(refresh))
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
  const parts = await readRanges(cache, source, [
    { offset: matrix.offset + index * width * 4, bytes: width * 4 },
    { offset: source.tensors.b_enc.offset + index * 4, bytes: 4 },
    { offset: source.tensors.threshold.offset + index * 4, bytes: 4 },
  ])
  return {
    weight: new Float32Array(parts[0].buffer),
    bias: new DataView(parts[1].buffer).getFloat32(0, true),
    threshold: new DataView(parts[2].buffer).getFloat32(0, true),
  }
}

/** Read a layer's packed tensors together, loading each cached chunk once. */
export async function readRanges(
  cache: Cache,
  source: WeightSource,
  ranges: Pick<TensorInfo, 'offset' | 'bytes'>[],
) {
  const chunks = await Promise.all(
    source.chunks
      .filter((chunk) =>
        ranges.some(
          (range) =>
            range.offset < chunk.offset + chunk.bytes &&
            range.offset + range.bytes > chunk.offset,
        ),
      )
      .map(async (chunk) => {
        const saved = await cache.match(key(chunk))
        if (!saved)
          throw new Error(
            'The browser cleared part of the model cache. Load the model again; no attempt was used.',
          )
        const data = new Uint8Array(await saved.arrayBuffer())
        if (data.length !== chunk.bytes) {
          await cache.delete(key(chunk))
          throw new Error(
            'The cached model weights are incomplete. Reload the model.',
          )
        }
        return { ...chunk, data }
      }),
  )
  return ranges.map(({ offset, bytes }) => {
    const whole = chunks.find(
      (chunk) => chunk.offset === offset && chunk.bytes === bytes,
    )
    if (whole) return whole.data
    const result = new Uint8Array(bytes)
    let copied = 0
    for (const chunk of chunks) {
      const from = Math.max(offset, chunk.offset),
        to = Math.min(offset + bytes, chunk.offset + chunk.bytes)
      if (to <= from) continue
      result.set(
        chunk.data.subarray(from - chunk.offset, to - chunk.offset),
        from - offset,
      )
      copied += to - from
    }
    if (copied !== bytes)
      throw new Error('Model tensor is outside the downloaded weights.')
    return result
  })
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
