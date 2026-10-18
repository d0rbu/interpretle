import { embeddingRows, readRanges } from './model-cache'
import type { TensorInfo, WeightSource } from './model-cache'
import { halfToFloat32, weightToHalf } from './model-math'
import { modelError } from './model-error'
import { runtimeReport } from './diagnostics'

export interface PreparedWeight {
  name: string
  shape: number[]
  data: Uint16Array | Float32Array
}

let source: WeightSource
let cpu = false
let cache: Promise<Cache>

self.onmessage = async ({ data: request }) => {
  let readMs = 0,
    decodeMs = 0
  const read = async <T>(run: () => Promise<T>) => {
    const start = performance.now()
    try {
      return await run()
    } finally {
      readMs += performance.now() - start
    }
  }
  const timing = (bytes = 0) => ({
    readMs: Math.round(readMs * 100) / 100,
    decodeMs: Math.round(decodeMs * 100) / 100,
    bytes,
  })
  try {
    if (request.source) {
      source = request.source
      cpu = request.cpu
      cache = caches.open('interpretle:model-v1')
    }
    const saved = await cache
    const entries = Object.entries(request.weights) as [string, TensorInfo][]
    const packed = await read(() =>
      readRanges(
        saved,
        source,
        entries.map(([, info]) => info),
      ),
    )
    const prepare = (
      name: string,
      bytes: Uint8Array,
      info: TensorInfo,
    ): PreparedWeight => {
      const start = performance.now()
      const half = weightToHalf(bytes, info.dtype)
      const data = cpu ? halfToFloat32(half) : half
      decodeMs += performance.now() - start
      return { name, shape: info.shape, data }
    }
    const weights = entries.map(([name, info], index) =>
      prepare(name, packed[index], info),
    )
    if (request.ids) {
      for (const [name, tensor] of [
        ['token_rows', 'embed_tokens.weight'],
        ['layer_rows', 'embed_tokens_per_layer.weight'],
      ]) {
        const info = source.tensors[`model.language_model.${tensor}`]
        const rows = await read(() =>
          embeddingRows(saved, source, info, request.ids),
        )
        weights.push(
          prepare(name, rows, {
            ...info,
            shape: [1, request.ids.length, info.shape[1]],
          }),
        )
      }
    }
    // Transfer ownership instead of copying the expanded weights.
    self.postMessage(
      {
        weights,
        timing: timing(weights.reduce((n, w) => n + w.data.byteLength, 0)),
      },
      {
        transfer: [
          ...new Set(weights.map(({ data }) => data.buffer as ArrayBuffer)),
        ],
      },
    )
  } catch (cause) {
    self.postMessage({
      error: modelError(cause, 'Preparing model weights'),
      report: runtimeReport(cause, request.stage, 'weights'),
      timing: timing(),
    })
  }
}
