// Large derived weights are generated locally, never committed to Git.
// Stop deployment if a checkout is missing any of the required static chunks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const root = resolve('dist')
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
for (const asset of local) {
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
}
console.log(`Verified ${local.length} model assets for deployment.`)
