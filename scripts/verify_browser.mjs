// Run with the Vite dev server on port 5173. Optionally pass a local copy of the
// pinned model.safetensors to avoid downloading the same 11 GB again in tests.
// This is a local test harness; it is never part of the deployed server.
import assert from 'node:assert/strict'
import { open, readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'

const model = JSON.parse(await readFile('public/model/manifest.json', 'utf8'))
const checkpoint = process.argv.find((arg) => arg.endsWith('.safetensors'))
const flags = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--disable-vulkan-surface',
]
if (process.env.INTERPRETLE_TEST_NVIDIA === '1')
  flags.push('--enable-dawn-features=vulkan_enable_f16_on_nvidia')
await mkdir('artifacts/browser-validation', { recursive: true })
const context = await chromium.launchPersistentContext(
  'artifacts/browser-validation',
  { headless: true, args: flags },
)
let weightRequests = 0
const file = checkpoint ? await open(checkpoint) : null
try {
  if (file) {
    await context.route(model.sources.model.url, async (route) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range)
      assert(match, 'Expected a fixed byte-range download')
      const start = Number(match[1]),
        size = Number(match[2]) - start + 1
      const body = Buffer.alloc(size)
      const { bytesRead } = await file.read(body, 0, size, start)
      assert.equal(bytesRead, size)
      weightRequests++
      await route.fulfill({
        status: 206,
        body,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${start + size - 1}/${(await file.stat()).size}`,
        },
      })
    })
    for (const [name, url] of Object.entries(model.tokenizer)) {
      await context.route(url, (route) =>
        route.fulfill({
          path: join(dirname(checkpoint), `${name}.json`),
          headers: {
            'access-control-allow-origin': '*',
            'content-type': 'application/json',
          },
        }),
      )
    }
  }
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  await page.goto('http://127.0.0.1:5173')
  await page.waitForLoadState('networkidle')
  const adapter = await page.evaluate(async () => {
    let adapter = await navigator.gpu?.requestAdapter({
      powerPreference: 'high-performance',
    })
    if (!adapter?.features.has('shader-f16'))
      adapter = await navigator.gpu?.requestAdapter({
        powerPreference: 'low-power',
      })
    return {
      vendor: adapter?.info.vendor,
      architecture: adapter?.info.architecture,
      f16: adapter?.features.has('shader-f16'),
    }
  })
  console.log(JSON.stringify({ adapter, flags, localWeightMirror: !!file }))
  let previous = ''
  await page.exposeFunction('modelProgress', (message) => {
    const key = message.startsWith('Downloading')
      ? message.split('.')[0]
      : message
    if (key !== previous) {
      console.log(message)
      previous = key
    }
  })
  await page.evaluate(
    async (descriptor) => {
      const { prepareBrowserModel } = await import('/src/lib/browser.ts')
      await prepareBrowserModel(
        descriptor,
        window.modelProgress,
        new AbortController().signal,
      )
    },
    { manifest: '/model/manifest.json', bytes: model.bytes },
  )
  console.log(`Model ready; ${weightRequests} weight downloads.`)
  if (!process.argv.includes('--prepare-only')) {
    const reference = JSON.parse(
      await readFile('artifacts/validation/reference.json', 'utf8'),
    )
    const results = []
    const requestsBeforeScoring = weightRequests
    // Run the Unicode/whitespace case first; it is sensitive to rounding drift.
    const examples = [...reference.cases.entries()].sort(
      ([a], [b]) => Number(b === 3) - Number(a === 3),
    )
    for (const [index, example] of examples) {
      const selected = process.argv.find((arg) => arg.startsWith('--case='))
      if (selected && index !== Number(selected.split('=')[1])) continue
      const started = Date.now()
      const actual = await page.evaluate(
        async ({ example, bytes }) => {
          const { scoreInBrowser } = await import('/src/lib/browser.ts')
          return scoreInBrowser(
            example.text,
            example.target,
            { manifest: '/model/manifest.json', bytes },
            window.modelProgress,
            new AbortController().signal,
          )
        },
        { example, bytes: model.bytes },
      )
      assert.deepEqual(
        actual.map((t) => t.id),
        example.ids.slice(1),
        'Tokenizer IDs',
      )
      assert.deepEqual(
        actual.map(({ start, end }) => ({ start, end })),
        example.offsets.slice(1),
        'Tokenizer offsets',
      )
      const differences = actual.map((t, i) =>
        Math.abs(t.activation - example.expected[i]),
      )
      const norm = Math.sqrt(
        differences.reduce((sum, value) => sum + value ** 2, 0) /
          example.expected.reduce((sum, value) => sum + value ** 2, 0),
      )
      const masks = actual.filter(
        (t, i) => t.activation > 0 !== example.expected[i] > 0,
      ).length
      const result = {
        index,
        feature: example.target.index,
        tokens: actual.length,
        seconds: (Date.now() - started) / 1000,
        maxAbsoluteError: Math.max(...differences),
        relativeL2Error: norm,
        activationMaskMismatches: masks,
      }
      console.log(JSON.stringify(result))
      results.push(result)
      await writeFile(
        'artifacts/browser-validation/results.json',
        JSON.stringify({ adapter, flags, results }, null, 2),
      )
      assert(
        norm < 0.01,
        'Browser activations differ from native by more than 1% relative L2',
      )
      assert(
        Math.max(...differences) < 0.1 + 0.01 * Math.max(...example.expected),
        'Large activation error',
      )
      assert.equal(masks, 0, 'Activation masks must agree on reference cases')
    }
    assert.equal(
      weightRequests,
      requestsBeforeScoring,
      'Scoring must never fetch input-dependent weights',
    )
    console.log(
      `Passed ${results.length} real WebGPU reference cases, with no weight requests during scoring.`,
    )
  }
} finally {
  await context.close()
  await file?.close()
}
