import { embeddingRows, readRanges } from './model-cache'
import type { TensorInfo, WeightSource } from './model-cache'
import { halfToFloat32, weightToHalf } from './model-math'
import { modelError } from './model-error'

export interface PreparedWeight {
  name: string
  shape: number[]
  data: Uint16Array | Float32Array
}

let source: WeightSource
let cpu = false
let cache: Promise<Cache>

self.onmessage = async ({ data: request }) => {
  try {
    if (request.source) {
      source = request.source
      cpu = request.cpu
      cache = caches.open('interpretle:model-v1')
    }
    const saved = await cache
    const entries = Object.entries(request.weights) as [string, TensorInfo][]
    const packed = await readRanges(
      saved,
      source,
      entries.map(([, info]) => info),
    )
    const prepare = (
      name: string,
      bytes: Uint8Array,
      info: TensorInfo,
    ): PreparedWeight => {
      const half = weightToHalf(bytes, info.dtype)
      return { name, shape: info.shape, data: cpu ? halfToFloat32(half) : half }
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
        const rows = await embeddingRows(saved, source, info, request.ids)
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
      { weights },
      {
        transfer: [
          ...new Set(weights.map(({ data }) => data.buffer as ArrayBuffer)),
        ],
      },
    )
  } catch (cause) {
    self.postMessage({ error: modelError(cause, 'Preparing model weights') })
  }
}
