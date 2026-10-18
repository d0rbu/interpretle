// Large derived weights are generated locally, never committed to Git.
// Stop deployment if a checkout is missing any of the required static chunks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

const root = resolve('dist')
assert(
  !(await readdir(root, { recursive: true })).some((file) =>
    file.endsWith('.map'),
  ),
  'Private source maps must not be deployed',
)
const catalog = JSON.parse(
  await readFile(resolve(root, 'puzzles/index.json'), 'utf8'),
)
const manifest = JSON.parse(
  await readFile(resolve(root, '.' + catalog.browserModel.manifest), 'utf8'),
)
assert.equal(manifest.bytes, catalog.browserModel.bytes, 'Catalog model size')
const local = [
  ...Object.values(manifest.graphs).flatMap((graph) => [
    graph,
    ...(graph.steps ?? []),
  ]),
  ...Object.values(manifest.cpuGraphs ?? {}).flatMap((graph) => [
    graph,
    ...(graph.steps ?? []),
  ]),
  ...Object.values(manifest.cpuRuntime ?? {}),
  ...Object.values(manifest.positions),
  ...Object.values(manifest.tokenizer),
  ...Object.values(manifest.sources).flatMap((source) => source.chunks),
]
async function readAsset(asset) {
  assert(asset.url.startsWith('/'), 'Expected a local model asset')
  const path = resolve(root, '.' + asset.url)
  assert(path.startsWith(root + sep), 'Invalid asset path')
  const data = await readFile(path)
  assert(
    data.length <= 25 * 1024 * 1024,
    `Asset exceeds Cloudflare's limit: ${asset.url}`,
  )
  assert.equal(
    createHash('sha256').update(data).digest('hex'),
    asset.sha256,
    asset.url,
  )
  if (asset.bytes) assert.equal(data.length, asset.bytes, asset.url)
  return data
}
let pieces = 0
for (const asset of local) {
  const data = await readAsset(asset)
  if (!asset.parts) continue
  const decoded = []
  for (const part of asset.parts) {
    const bytes = await readAsset(part)
    assert(!part.compression || part.compression === 'gzip')
    const raw = part.compression ? gunzipSync(bytes) : bytes
    assert(raw.length <= 1024 * 1024, `Download piece too large: ${part.url}`)
    assert.equal(raw.length, part.decodedBytes ?? part.bytes, part.url)
    decoded.push(raw)
    pieces++
  }
  assert(
    data.equals(Buffer.concat(decoded)),
    `Download pieces differ: ${asset.url}`,
  )
}
console.log(
  `Verified ${local.length} model assets and ${pieces} download pieces for deployment.`,
)
