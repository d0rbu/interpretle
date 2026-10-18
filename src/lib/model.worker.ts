import type * as Ort from 'onnxruntime-web'
import { Tokenizer } from '@huggingface/tokenizers'
import {
  cachedFile,
  downloadWeights,
  pruneModelCache,
  saeEncoder,
} from './model-cache'
import type { ModelAsset, TensorInfo, WeightSource } from './model-cache'
import {
  floatToHalf,
  halfToFloat,
  halfToFloat32,
  tokenOffsets,
} from './model-math'
import type { Feature, TokenActivation } from './types'
import { modelDiagnostics, modelError } from './model-error'
import type { ModelDiagnostics } from './model-error'
import { runSteps } from './model-steps'
import type { ModelStep } from './model-steps'
import type { PreparedWeight } from './model-weights.worker'
import { breadcrumb, runtimeReport } from './diagnostics'
import type { Breadcrumb, RuntimeReport } from './diagnostics'
import { ForwardProfile } from './model-profile'
import type { ModelProfile } from './model-profile'

type Asset = ModelAsset & { gpuOutputs?: string[] }
type Graph = Asset & {
  weights: Record<string, string>
  steps?: (Asset & { label: string })[]
}
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

let backend: ModelDiagnostics['backend'] = 'unknown'
const trail: Breadcrumb[] = []
const reportContext: Partial<RuntimeReport> = {}
const progress = (message: string, fraction?: number) => {
  breadcrumb(trail, message)
  self.postMessage({ progress: message, fraction, backend })
}
let manifest: Manifest, cache: Cache, tokenizer: Tokenizer
let prepared = false
let stage = 'Model startup'
let ort: typeof Ort, graphs: Record<string, Graph>
let cpu = false
let weightWorker: Worker | undefined
const sessions: Record<string, ModelStep[]> = {}
const positions: Record<string, Uint16Array> = {}
let profile: ForwardProfile | undefined
let runs = 0
const profileSnapshot = (status: ModelProfile['status']) =>
  profile?.snapshot(status)

async function prepare(url: string) {
  if (prepared) return
  reportContext.manifest = url
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
  stage = 'Cleaning outdated model files'
  await pruneModelCache(cache, Object.values(manifest.sources), [
    ...Object.values(manifest.graphs).flatMap((graph) => [
      graph,
      ...(graph.steps ?? []),
    ]),
    ...Object.values(manifest.cpuGraphs).flatMap((graph) => [
      graph,
      ...(graph.steps ?? []),
    ]),
    ...Object.values(manifest.cpuRuntime),
    ...Object.values(manifest.positions),
    ...Object.values(manifest.tokenizer),
  ])
  stage = 'Model data download'
  for (const [name, asset] of Object.entries(manifest.positions)) {
    const bytes = await cachedFile(cache, asset)
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
    const bytes = await cachedFile(cache, asset)
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
      reportContext.gpu = [adapter.info?.vendor, adapter.info?.architecture]
        .filter(Boolean)
        .join(' / ')
    } catch {
      /* Optional diagnostics must not stop model preparation. */
    }
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
    breadcrumb(trail, 'GPU setup failed; falling back to CPU')
    for (const name of Object.keys(sessions)) {
      for (const step of sessions[name]) await step.session.release()
      delete sessions[name]
    }
    device.destroy()
    progress('GPU unavailable; preparing the CPU model…')
    await loadSessions()
  }
  stage = 'Model weight download'
  await downloadWeights(cache, Object.values(manifest.sources), progress)
  prepared = true
  progress(`Local model ready (${cpu ? 'CPU' : 'GPU'}).`)
}

async function loadSessions(device?: GPUDevice, adapter?: GPUAdapter | null) {
  backend = device ? 'gpu' : 'cpu'
  stage = `Preparing the ${device ? 'GPU' : 'CPU'} runtime`
  progress(`Preparing the local model (${device ? 'GPU' : 'CPU'})…`)
  cpu = !device
  ort = cpu
    ? await import('onnxruntime-web/wasm')
    : await import('onnxruntime-web/webgpu')
  ort.env.wasm.numThreads =
    cpu && self.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1
  reportContext.threads = ort.env.wasm.numThreads
  if (cpu) {
    ort.env.wasm.wasmPaths = {
      mjs: new URL(manifest.cpuRuntime.mjs.url, location.origin).href,
    }
    ort.env.wasm.wasmBinary = await cachedFile(cache, manifest.cpuRuntime.wasm)
  } else {
    // The GPU runtime exceeds Cloudflare's per-file asset limit.
    ort.env.wasm.wasmPaths =
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/'
    ort.env.webgpu.adapter = adapter!
  }
  graphs = cpu ? manifest.cpuGraphs : manifest.graphs
  for (const [name, graph] of Object.entries(graphs)) {
    sessions[name] = []
    for (const part of graph.steps ?? [
      {
        ...graph,
        label: name === 'embedding' ? 'Embeddings' : 'Transformer layer',
      },
    ]) {
      stage = `Loading the ${name} ${part.label} ${cpu ? 'CPU' : 'GPU'} graph`
      sessions[name].push({
        label: part.label,
        session: await ort.InferenceSession.create(
          await cachedFile(cache, part),
          {
            executionProviders: device
              ? [{ name: 'webgpu', device }]
              : ['wasm'],
            graphOptimizationLevel: 'disabled',
            // Keep activations on the GPU between steps; shape outputs stay on CPU.
            preferredOutputLocation: device
              ? Object.fromEntries(
                  (part.gpuOutputs ?? []).map((name) => [name, 'gpu-buffer']),
                )
              : undefined,
          },
        ),
      })
    }
  }
}

function tensor(bits: Uint16Array, shape: number[]) {
  return cpu
    ? new ort.Tensor('float32', halfToFloat32(bits), shape)
    : new ort.Tensor('float16', bits, shape)
}

function graphWeights(
  graph: Graph,
  layer?: number,
): Record<string, TensorInfo> {
  return Object.fromEntries(
    Object.entries(graph.weights).map(([name, template]) => [
      name,
      manifest.sources.model.tensors[
        template.replace('{layer}', String(layer))
      ],
    ]),
  )
}

function readWeights(graph: Graph, layer?: number, ids?: number[]) {
  const start = performance.now()
  const pass = profile
  const source = manifest.sources.model
  const first = !weightWorker
  weightWorker ??= new Worker(
    new URL('./model-weights.worker.ts', import.meta.url),
    { type: 'module' },
  )
  const current = weightWorker
  // There is only one pending read: consume it before requesting the next layer.
  return new Promise<PreparedWeight[]>((resolve, reject) => {
    current.onmessage = ({ data }) => {
      current.onmessage = null
      current.onerror = null
      pass?.record('weights', 'Read & prepare weights', start, layer, {
        ...data.timing,
        ...(data.error ? { failed: true } : {}),
      })
      if (data.error)
        reject(Object.assign(new Error(data.error), { report: data.report }))
      else resolve(data.weights)
    }
    current.onerror = (event) => {
      pass?.record('weights', 'Read & prepare weights', start, layer, {
        failed: true,
      })
      current.terminate()
      weightWorker = undefined
      reject(
        Object.assign(
          new Error(modelError(event, 'Weight preparation worker')),
          {
            report: runtimeReport(
              event,
              'Weight preparation worker',
              'weights',
            ),
          },
        ),
      )
    }
    current.postMessage({
      ...(first ? { source, cpu } : {}),
      weights: graphWeights(graph, layer),
      stage:
        layer === undefined
          ? 'Reading embedding weights'
          : `Reading layer ${layer + 1} weights`,
      ids,
    })
  })
}

function weightTensors(weights: PreparedWeight[]) {
  return Object.fromEntries(
    weights.map(({ name, shape, data }) => [
      name,
      cpu
        ? new ort.Tensor('float32', data as Float32Array, shape)
        : new ort.Tensor('float16', data as Uint16Array, shape),
    ]),
  )
}

async function halfBits(tensor: Ort.Tensor) {
  const data = await tensor.getData()
  if (tensor.type === 'float32') return floatToHalf(data as Float32Array)
  // ORT returns Float16Array on newer browsers and Uint16Array on older ones.
  // Read the same underlying bits in either case.
  const bits = data as Uint16Array
  return new Uint16Array(bits.buffer, bits.byteOffset, bits.byteLength / 2)
}

async function score(
  text: string,
  target: Pick<Feature, 'kind' | 'index'>,
): Promise<TokenActivation[]> {
  const pass = (profile = new ForwardProfile({
    backend: cpu ? 'cpu' : 'gpu',
    threads: reportContext.threads ?? 1,
    run: ++runs,
    manifest: reportContext.manifest ?? '',
  }))
  stage = 'Text tokenization'
  const tokenizing = performance.now()
  const encoded = tokenizer.encode(text, { add_special_tokens: false })
  const offsets = tokenOffsets(text, encoded.tokens)
  const ids = [manifest.bos, ...encoded.ids],
    length = ids.length
  reportContext.tokens = length
  pass.tokens = length
  pass.record('tokenize', 'Tokenization', tokenizing)
  if (length > manifest.maxTokens)
    throw new Error(
      `This sentence exceeds ${manifest.maxTokens - 1} model tokens. Shorten it and retry; no attempt was used.`,
    )
  if (encoded.ids.some((id) => manifest.specialIds.includes(id)))
    throw new Error(
      'Please use ordinary text without model control tokens. No attempt was used.',
    )
  self.postMessage({
    tokens: encoded.ids.map((id, index) => ({ id, ...offsets[index] })),
    profile: pass.snapshot('running'),
  })
  const totalSteps =
    sessions.embedding.length +
    manifest.layers.reduce((sum, kind) => sum + sessions[kind].length, 0) +
    1
  let completed = 0
  const report = (label: string, finished = false) => {
    if (finished) completed++
    stage = label
    progress(
      `Scoring: ${cpu ? 'CPU' : 'GPU'} · ${label}…`,
      completed / totalSteps,
    )
  }
  report('Reading embedding weights')
  const embeddingFeeds = weightTensors(
    await pass.measure('wait', 'Await embedding weights', () =>
      readWeights(graphs.embedding, undefined, ids),
    ),
  )
  // Reserve output bytes before queuing work. Reads and conversion run serially
  // on the preparation worker, in parallel with inference, within this budget.
  const budget = 2_000_000_000
  const pending: { bytes: number; weights: Promise<PreparedWeight[]> }[] = []
  let reserved = 0
  let queued = 0
  let reading: Promise<unknown> = Promise.resolve()
  const prefetch = () => {
    while (queued < manifest.layers.length) {
      const index = queued
      const bytes = Object.values(
        graphWeights(graphs[manifest.layers[index]], index),
      ).reduce(
        (sum, { shape }) =>
          sum + shape.reduce((n, dim) => n * dim, cpu ? 4 : 2),
        0,
      )
      if (bytes > budget)
        throw new Error(
          'This model layer exceeds the local weight buffer budget.',
        )
      if (reserved + bytes > budget) break
      queued++
      const next = reading.then(() =>
        readWeights(graphs[manifest.layers[index]], index),
      )
      // Inference can fail or be cancelled before every queued read is used.
      void next.catch(() => {})
      pending.push({ bytes, weights: next })
      reserved += bytes
      reading = next
    }
  }
  prefetch()
  const embedding = await runSteps(
    sessions.embedding,
    embeddingFeeds,
    ['hidden', 'per_layer'],
    report,
    (name, start, failed) =>
      pass.record('compute', name, start, undefined, { failed }),
  )
  Object.values(embeddingFeeds).forEach((tensor) => tensor.dispose())
  let hidden = embedding.hidden
  let mlp: Ort.Tensor | undefined
  const allPerLayer = await pass.measure('readback', 'Embedding readback', () =>
    halfBits(embedding.per_layer),
  )
  const maskData = new Uint16Array(length * length)
  for (let row = 0; row < length; row++)
    maskData.fill(0xfbff, row * length + row + 1, (row + 1) * length)
  const mask = tensor(maskData, [1, 1, length, length])
  for (const [index, kind] of manifest.layers.entries()) {
    const layer = `Layer ${index + 1}/${manifest.layers.length}`
    report(`${layer} · Reading weights`)
    const next = pending.shift()!
    const weights = await pass.measure(
      'wait',
      'Await layer weights',
      () => next.weights,
      index,
    )
    reserved -= next.bytes
    prefetch()
    const inputStart = performance.now()
    const feeds = weightTensors(weights)
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
    pass.record('inputs', 'Prepare layer inputs', inputStart, index)
    const output = await runSteps(
      sessions[kind],
      { ...feeds, hidden, mask },
      captureMlp ? ['output', 'mlp'] : ['output'],
      (label, finished) => report(`${layer} · ${label}`, finished),
      (name, start, failed) =>
        pass.record('compute', name, start, index, { failed }),
    )
    hidden.dispose()
    Object.values(feeds).forEach((tensor) => tensor.dispose())
    hidden = output.output
    if (captureMlp) mlp = output.mlp
    self.postMessage({ profile: pass.snapshot('running') })
  }
  report('Feature activation')
  const values = await pass.measure('readback', 'Activation readback', () =>
    halfBits(mlp ?? hidden),
  )
  if (values.some((value) => (value & 0x7c00) === 0x7c00))
    throw new Error(
      'The local model returned non-finite values. No attempt was used.',
    )
  const encoder =
    target.kind === 'sae'
      ? await pass.measure('activation', 'Read SAE encoder', () =>
          saeEncoder(cache, manifest.sources.sae, target.index),
        )
      : undefined
  const activationStart = performance.now()
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
  pass.record('activation', 'Feature activation', activationStart)
  hidden.dispose()
  mlp?.dispose()
  embedding.per_layer.dispose()
  mask.dispose()
  report('Feature activation', true)
  return result
}

self.onmessage = async ({ data }) => {
  const started = performance.now()
  trail.length = 0
  delete reportContext.tokens
  profile = undefined
  try {
    await prepare(data.manifest)
    self.postMessage({
      result:
        data.type === 'score' ? await score(data.text, data.target) : null,
      profile: profileSnapshot('ok'),
    })
  } catch (cause) {
    const errorStage =
      (cause as { report?: RuntimeReport } | null)?.report?.stage ?? stage
    self.postMessage({
      error: modelError(cause, errorStage),
      diagnostics: modelDiagnostics(cause, errorStage, backend),
      profile: profileSnapshot('error'),
      report: runtimeReport(cause, errorStage, 'model', {
        ...reportContext,
        elapsedMs: Math.round(performance.now() - started),
        trail: [
          ...((cause as { report?: RuntimeReport })?.report?.trail ?? []),
          ...trail,
        ],
      }),
    })
  }
}
