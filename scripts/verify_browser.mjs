// Run with the Vite dev server on port 5173. All model and tokenizer assets are
// served locally from public/model/weights, exactly as they are on Cloudflare.
// This is a local test harness; it is never part of the deployed server.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium, firefox } from '@playwright/test'

const descriptor = JSON.parse(
  await readFile('public/puzzles/index.json', 'utf8'),
).browserModel
const referencePath =
  process.argv.find((arg) => arg.startsWith('--reference='))?.slice(12) ??
  'artifacts/validation/reference.json'
const resultsPath =
  process.argv.find((arg) => arg.startsWith('--results='))?.slice(10) ??
  'artifacts/browser-validation/results.json'
const useFirefox = process.argv.includes('--firefox')
const cpu = useFirefox || process.argv.includes('--cpu')
const flags = cpu
  ? useFirefox
    ? []
    : ['--disable-webgpu']
  : [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--disable-vulkan-surface',
    ]
if (!cpu && process.env.INTERPRETLE_TEST_NVIDIA === '1')
  flags.push('--enable-dawn-features=vulkan_enable_f16_on_nvidia')
const profile =
  process.env.INTERPRETLE_TEST_PROFILE ??
  (useFirefox
    ? 'artifacts/browser-validation-firefox'
    : 'artifacts/browser-validation')
await mkdir(profile, { recursive: true })
const context = await (useFirefox ? firefox : chromium).launchPersistentContext(
  profile,
  {
    headless: true,
    args: flags,
    ...(useFirefox && { firefoxUserPrefs: { 'dom.webgpu.enabled': false } }),
  },
)
let weightRequests = 0
try {
  await context.route('**/api/events', (route) =>
    route.fulfill({ status: 204 }),
  )
  // Keep frontend hot reloads from interrupting a numerical validation run.
  await context.routeWebSocket('**/*', (socket) => socket.close())
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/model/weights/'))
      weightRequests++
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  await page.goto(process.env.INTERPRETLE_TEST_URL ?? 'http://127.0.0.1:5173')
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
  console.log(JSON.stringify({ adapter, flags }))
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
  await page.evaluate(async (descriptor) => {
    const { prepareBrowserModel } = await import('/src/lib/browser.ts')
    await prepareBrowserModel(
      descriptor,
      window.modelProgress,
      new AbortController().signal,
    )
  }, descriptor)
  console.log(`Model ready; ${weightRequests} weight downloads.`)
  if (!process.argv.includes('--prepare-only')) {
    const reference = JSON.parse(await readFile(referencePath, 'utf8'))
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
        async ({ example, descriptor }) => {
          const { scoreInBrowser } = await import('/src/lib/browser.ts')
          return scoreInBrowser(
            example.text,
            example.target,
            descriptor,
            window.modelProgress,
            new AbortController().signal,
          )
        },
        { example, descriptor },
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
        kind: example.target.kind,
        tokens: actual.length,
        seconds: (Date.now() - started) / 1000,
        maxAbsoluteError: Math.max(...differences),
        relativeL2Error: norm,
        activationMaskMismatches: masks,
      }
      console.log(JSON.stringify(result))
      results.push(result)
      await writeFile(
        resultsPath,
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
      `Passed ${results.length} real ${cpu ? 'CPU' : 'WebGPU'} reference cases, with no weight requests during scoring.`,
    )
  }
} finally {
  await context.close()
}
