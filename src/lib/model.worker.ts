import type * as Ort from 'onnxruntime-web'
import { Tokenizer } from '@huggingface/tokenizers'
import {
  cachedFile,
  downloadWeights,
  embeddingRows,
  readRange,
  saeEncoder,
} from './model-cache'
import type { TensorInfo, WeightSource } from './model-cache'
import {
  bf16ToHalf,
  floatToHalf,
  fp4ToHalf,
  halfToFloat,
  tokenOffsets,
} from './model-math'
import type { Feature, TokenActivation } from './types'
import { modelError } from './model-error'

type Asset = { url: string; sha256: string; bytes?: number }
type Graph = Asset & { weights: Record<string, string> }
interface Manifest {
  version: string
  maxTokens: number
  bos: number
  specialIds: number[]
  tokenizer: { tokenizer: Asset; tokenizer_config: Asset }
  graphs: Record<string, Graph>
  cpuGraphs: Record<string, Graph>
  cpuRuntime: { mjs: Asset; wasm: Asset }
  positions: Record<string, Asset & { shape: number[] }>
  layers: string[]
  sources: { model: WeightSource; sae: WeightSource }
  sae: { inputBias: number[] }
}

const prefix = 'model.language_model.'
const progress = (message: string, fraction?: number) =>
  self.postMessage({ progress: message, fraction })
let manifest: Manifest, cache: Cache, tokenizer: Tokenizer
let prepared = false
let stage = 'Model startup'
let ort: typeof Ort, graphs: Record<string, Graph>
let cpu = false
const sessions: Record<string, Ort.InferenceSession> = {}
const positions: Record<string, Uint16Array> = {}

async function prepare(url: string) {
  if (prepared) return
  if (!('caches' in self))
    throw new Error(
      'Browser model storage is unavailable. Suggested passages still work.',
    )
  progress('Preparing the local model…')
  stage = 'Model manifest download'
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`The model manifest returned HTTP ${response.status}.`)
  manifest = await response.json()
  stage = 'Browser storage'
  cache = await caches.open('interpretle:model-v1')
  stage = 'Model data download'
  for (const [name, asset] of Object.entries(manifest.positions)) {
    const bytes = await cachedFile(cache, asset.url, asset.sha256)
    positions[name] = new Uint16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    )
  }
  const decoder = new TextDecoder()
  const files: Record<string, object> = {}
  for (const [name, asset] of Object.entries(manifest.tokenizer)) {
    stage = `Tokenizer ${name === 'tokenizer' ? 'vocabulary' : 'configuration'} download`
    const bytes = await cachedFile(cache, asset.url, asset.sha256)
    stage = `Parsing the tokenizer ${name === 'tokenizer' ? 'vocabulary' : 'configuration'}`
    const parsed: unknown = JSON.parse(decoder.decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(
        `Expected a JSON object in ${name}.json. Retry the download.`,
      )
    files[name] = parsed
  }
  stage = 'Tokenizer initialization'
  tokenizer = new Tokenizer(files.tokenizer, files.tokenizer_config)
  stage = 'Local runtime setup'
  let adapter: GPUAdapter | null = null
  try {
    adapter =
      (await navigator.gpu?.requestAdapter({
        powerPreference: 'high-performance',
      })) ?? null
    if (!adapter?.features.has('shader-f16'))
      adapter =
        (await navigator.gpu?.requestAdapter({
          powerPreference: 'low-power',
        })) ?? null
  } catch {
    /* CPU also works when the browser blocks GPU access. */
  }
  let device: GPUDevice | undefined
  if (adapter?.features.has('shader-f16')) {
    try {
      device = await adapter.requestDevice({
        requiredFeatures: ['shader-f16'],
        requiredLimits: {
          maxStorageBufferBindingSize:
            adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
        },
      })
    } catch {
      /* Fall back to CPU if a usable device cannot be created. */
    }
  }
  try {
    await loadSessions(device, adapter)
  } catch (cause) {
    if (!device) throw cause
    for (const name of Object.keys(sessions)) {
      await sessions[name].release()
      delete sessions[name]
    }
    device.destroy()
    progress('GPU unavailable; preparing the CPU model…')
    await loadSessions()
  }
  stage = 'Model weight download'
  await downloadWeights(cache, Object.values(manifest.sources), progress)
  prepared = true
  progress(
    `Local model ready (${cpu ? 'CPU' : 'GPU'}). Your sentence stays on this device.`,
  )
}

async function loadSessions(device?: GPUDevice, adapter?: GPUAdapter | null) {
  stage = `Preparing the ${device ? 'GPU' : 'CPU'} runtime`
  progress(`Preparing the local ${device ? 'GPU' : 'CPU'} model…`)
  cpu = !device
  ort = cpu
    ? await import('onnxruntime-web/wasm')
    : await import('onnxruntime-web/webgpu')
  ort.env.wasm.numThreads =
    cpu && self.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1
  if (cpu) {
    ort.env.wasm.wasmPaths = {
      mjs: new URL(manifest.cpuRuntime.mjs.url, location.origin).href,
    }
    ort.env.wasm.wasmBinary = await cachedFile(
      cache,
      manifest.cpuRuntime.wasm.url,
      manifest.cpuRuntime.wasm.sha256,
    )
  } else {
    // The GPU runtime exceeds Cloudflare's per-file asset limit.
    ort.env.wasm.wasmPaths =
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/'
    ort.env.webgpu.adapter = adapter!
  }
  graphs = cpu ? manifest.cpuGraphs : manifest.graphs
  for (const [name, graph] of Object.entries(graphs)) {
    stage = `Loading the ${name} ${cpu ? 'CPU' : 'GPU'} model graph`
    sessions[name] = await ort.InferenceSession.create(
      await cachedFile(cache, graph.url, graph.sha256),
      {
        executionProviders: device ? [{ name: 'webgpu', device }] : ['wasm'],
        graphOptimizationLevel: 'disabled',
      },
    )
  }
}

function tensor(bits: Uint16Array, shape: number[]) {
  return cpu
    ? new ort.Tensor('float32', Float32Array.from(bits, halfToFloat), shape)
    : new ort.Tensor('float16', bits, shape)
}

function half(bytes: Uint8Array, info: TensorInfo) {
  if (info.dtype === 'FP4') return fp4ToHalf(bytes)
  if (info.dtype === 'BF16')
    return bf16ToHalf(
      new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    )
  if (info.dtype === 'F16')
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  if (info.dtype === 'F32')
    return floatToHalf(
      new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    )
  throw new Error(`Unsupported model weight type: ${info.dtype}.`)
}

async function weights(graph: Graph, layer?: number) {
  const result: Record<string, Ort.Tensor> = {}
  const source = manifest.sources.model
  for (const [input, template] of Object.entries(graph.weights)) {
    const name = template.replace('{layer}', String(layer)),
      info = source.tensors[name]
    result[input] = tensor(
      half(await readRange(cache, source, info.offset, info.bytes), info),
      info.shape,
    )
  }
  return result
}

function halfBits(tensor: Ort.Tensor) {
  if (tensor.type === 'float32') return floatToHalf(tensor.data as Float32Array)
  // ORT returns Float16Array on newer browsers and Uint16Array on older ones.
  // Read the same underlying bits in either case.
  const data = tensor.data as Uint16Array
  return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
}

async function score(
  text: string,
  target: Pick<Feature, 'kind' | 'index'>,
): Promise<TokenActivation[]> {
  stage = 'Text tokenization'
  const encoded = tokenizer.encode(text, { add_special_tokens: false })
  const offsets = tokenOffsets(text, encoded.tokens)
  const ids = [manifest.bos, ...encoded.ids],
    length = ids.length
  if (length > manifest.maxTokens)
    throw new Error(
      `This sentence exceeds ${manifest.maxTokens - 1} model tokens. Shorten it and retry; no attempt was used.`,
    )
  if (encoded.ids.some((id) => manifest.specialIds.includes(id)))
    throw new Error(
      'Please use ordinary text without model control tokens. No attempt was used.',
    )
  const source = manifest.sources.model
  stage = 'Reading model weights'
  const embeddingFeeds = await weights(graphs.embedding)
  for (const [input, name] of [
    ['token_rows', 'embed_tokens.weight'],
    ['layer_rows', 'embed_tokens_per_layer.weight'],
  ]) {
    const info = source.tensors[prefix + name]
    embeddingFeeds[input] = tensor(
      half(await embeddingRows(cache, source, info, ids), info),
      [1, length, info.shape[1]],
    )
  }
  stage = 'Scoring embeddings'
  progress('Scoring locally: embeddings…')
  const embedding = await sessions.embedding.run(embeddingFeeds)
  Object.values(embeddingFeeds).forEach((tensor) => tensor.dispose())
  let hidden = embedding.hidden
  let mlp: Ort.Tensor | undefined
  const allPerLayer = halfBits(embedding.per_layer)
  const maskData = new Uint16Array(length * length)
  for (let row = 0; row < length; row++)
    maskData.fill(0xfbff, row * length + row + 1, (row + 1) * length)
  const mask = tensor(maskData, [1, 1, length, length])
  for (const [index, kind] of manifest.layers.entries()) {
    stage = `Scoring layer ${index + 1} of ${manifest.layers.length}`
    progress(
      `Scoring locally${cpu ? ' on CPU' : ''}: layer ${index + 1} of ${manifest.layers.length}…`,
      index / manifest.layers.length,
    )
    const feeds = await weights(graphs[kind], index)
    const perLayer = new Uint16Array(length * 256)
    for (let token = 0; token < length; token++) {
      const start = (token * manifest.layers.length + index) * 256
      perLayer.set(allPerLayer.subarray(start, start + 256), token * 256)
    }
    feeds.per_layer = tensor(perLayer, [1, length, 256])
    for (const part of ['cosine', 'sine']) {
      const key = `${kind}_${part}`,
        dim = manifest.positions[key].shape[2]
      feeds[part] = tensor(positions[key].subarray(0, length * dim), [
        1,
        length,
        dim,
      ])
    }
    const captureMlp =
      target.kind === 'mlp' && index === manifest.layers.length - 1
    const output = await sessions[kind].run(
      { ...feeds, hidden, mask },
      captureMlp ? ['output', 'mlp'] : ['output'],
    )
    hidden.dispose()
    Object.values(feeds).forEach((tensor) => tensor.dispose())
    hidden = output.output
    if (captureMlp) mlp = output.mlp
  }
  stage = 'Reading activations'
  const values = halfBits(mlp ?? hidden)
  if (values.some((value) => (value & 0x7c00) === 0x7c00))
    throw new Error(
      'The local model returned non-finite values. No attempt was used.',
    )
  const encoder =
    target.kind === 'sae'
      ? await saeEncoder(cache, manifest.sources.sae, target.index)
      : undefined
  const result = encoded.ids.map((id, index) => {
    const start = (index + 1) * (target.kind === 'mlp' ? 10240 : 2560)
    let activation: number
    if (target.kind === 'neuron' || target.kind === 'mlp')
      activation = Math.max(0, halfToFloat(values[start + target.index]))
    else {
      if (!encoder || encoder.weight.length !== 2560)
        throw new Error('This puzzle is missing its SAE encoder.')
      let sum = 0
      for (let column = 0; column < 2560; column++) {
        const centered = Math.fround(
          halfToFloat(values[start + column]) - manifest.sae.inputBias[column],
        )
        sum += centered * encoder.weight[column]
      }
      const pre = Math.fround(sum + encoder.bias)
      activation = pre > encoder.threshold ? Math.max(0, pre) : 0
    }
    if (!Number.isFinite(activation))
      throw new Error(
        'The local model returned a non-finite activation. No attempt was used.',
      )
    return { id, ...offsets[index], activation }
  })
  hidden.dispose()
  mlp?.dispose()
  embedding.per_layer.dispose()
  mask.dispose()
  return result
}

self.onmessage = async ({ data }) => {
  try {
    await prepare(data.manifest)
    self.postMessage({
      result:
        data.type === 'score' ? await score(data.text, data.target) : null,
    })
  } catch (cause) {
    self.postMessage({ error: modelError(cause, stage) })
  }
}
