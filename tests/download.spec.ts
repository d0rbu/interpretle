import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test as base, expect } from '@playwright/test'
import { build } from 'vite'

const test = base.extend({
  context: async ({ playwright, browserName }, use, info) => {
    // WebKit's ephemeral test contexts clear cached bodies on reload. A normal
    // browser profile exercises the durable storage used by regular Safari.
    const profile = await mkdtemp(join(tmpdir(), 'interpretle-download-test-'))
    const options = info.project.use
    const context = await playwright[browserName].launchPersistentContext(
      profile,
      {
        viewport: options.viewport,
        userAgent: options.userAgent,
        isMobile: options.isMobile,
        hasTouch: options.hasTouch,
        deviceScaleFactor: options.deviceScaleFactor,
      },
    )
    try {
      await use(context)
    } finally {
      await context.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
})

const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const pieces = Array.from({ length: 4 }, (_, n) =>
  Buffer.alloc(1024 * 1024, n + 1),
)
const full = Buffer.concat(pieces)
const tokenizer = Buffer.from(
  JSON.stringify({ vocab: 'some tokenizer text '.repeat(100000) }),
)
const compressed = gzipSync(tokenizer)
let server: Server, origin: string, script: string
let requests: number[], hold: boolean

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      outDir: 'artifacts/download-test',
      write: false,
      minify: false,
      lib: {
        entry: 'src/lib/model-cache.ts',
        formats: ['es'],
        fileName: 'cache',
      },
    },
  })
  const bundle = Array.isArray(result) ? result[0] : result
  const output =
    'output' in bundle && bundle.output.find((asset) => asset.type === 'chunk')
  if (!output || output.type !== 'chunk')
    throw new Error('Missing download test bundle')
  script = output.code
})

test.beforeEach(async () => {
  requests = [0, 0, 0, 0]
  hold = true
  server = createServer((request, response) => {
    const path = request.url!
    if (path === '/cache.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(script)
    } else if (path === '/worker.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(`
        import { downloadWeights, cachedFile } from '/cache.js';
        onmessage = async ({ data }) => {
          try {
            const cache = await caches.open('resumable-test');
            let writeAttempts = 0;
            const put = cache.put.bind(cache);
            cache.put = async (...args) => {
              writeAttempts++;
              if (writeAttempts <= (data.failWrites || 0)) {
                const error = new TypeError(writeAttempts === 1 ? 'Internal error' : 'Failed writing data to the file system');
                if (data.stackless) error.stack = undefined;
                throw error;
              }
              return put(...args);
            };
            if (data.file) await cachedFile(cache, data.file);
            else await downloadWeights(cache, [data.source],
              (message, fraction) => postMessage({ fraction }));
            postMessage({ done: true, writeAttempts });
          } catch (error) { postMessage({ error: String(error), report: error.report }); }
        };`)
    } else if (path.startsWith('/part/')) {
      const index = Number(path.slice('/part/'.length))
      requests[index]++
      response.setHeader('Content-Length', pieces[index].length)
      response.setHeader('Content-Type', 'application/octet-stream')
      if (hold && index === 2)
        response.write(pieces[index].subarray(0, 128 * 1024))
      else response.end(pieces[index])
    } else if (path === '/tokenizer.gz') {
      response.setHeader('Content-Type', 'application/gzip')
      response.end(compressed)
    } else {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><title>Download recovery test</title>')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing test port')
  origin = `http://127.0.0.1:${address.port}`
})

test('recovers transient Safari write errors without losing pieces or repeating transfers', async ({
  page,
}) => {
  hold = false
  const asset = {
    url: '/unused-whole-file',
    offset: 0,
    bytes: full.length,
    sha256: hash(full),
    parts: pieces.map((bytes, n) => ({
      url: `/part/${n}`,
      sha256: hash(bytes),
      bytes: bytes.length,
    })),
  }
  await page.goto(origin)
  const result = await page.evaluate(
    (source) =>
      new Promise<{ done?: boolean; error?: string; writeAttempts: number }>(
        (resolve) => {
          const worker = new Worker('/worker.js', { type: 'module' })
          worker.onmessage = ({ data }) => {
            if (data.done || data.error) {
              worker.terminate()
              resolve(data)
            }
          }
          worker.postMessage({ source, failWrites: 2 })
        },
      ),
    { tensors: {}, chunks: [asset] },
  )
  expect(result).toEqual({ done: true, writeAttempts: 7 })
  expect(requests).toEqual([1, 1, 1, 1])
  const saved = await page.evaluate(async (hash) => {
    const cache = await caches.open('resumable-test')
    const response = await cache.match(
      new URL(`/__model_cache/${hash}`, location.origin).href,
    )
    return {
      keys: (await cache.keys()).length,
      bytes: (await response!.arrayBuffer()).byteLength,
    }
  }, asset.sha256)
  expect(saved).toEqual({ keys: 1, bytes: full.length })
})

test.afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

test('captures the original download caller when native storage errors have no stack', async ({
  page,
}) => {
  hold = false
  await page.goto(origin)
  const result = await page.evaluate(
    (file) =>
      new Promise<{
        error: string
        report: {
          stack?: string
          operationStack: string
          captureStack: string
          storageAttempts: number
        }
      }>((resolve) => {
        const worker = new Worker('/worker.js', { type: 'module' })
        worker.onmessage = ({ data }) => {
          if (data.error) {
            worker.terminate()
            resolve(data)
          }
        }
        worker.postMessage({ file, failWrites: 3, stackless: true })
      }),
    { url: '/tokenizer.gz', bytes: compressed.length },
  )
  expect(result.error).toContain('Failed writing data to the file system')
  expect(result.report.stack).toBeUndefined()
  expect(result.report.storageAttempts).toBe(3)
  expect(result.report.operationStack).toMatch(/cacheWrite[\s\S]*cachedFile/)
  expect(result.report.captureStack).toContain('runtimeReport')
})

test('retains partial downloads after reload and decodes gzip with real browser storage', async ({
  page,
}) => {
  const asset = {
    url: '/unused-whole-file',
    offset: 0,
    bytes: full.length,
    sha256: hash(full),
    parts: pieces.map((bytes, n) => ({
      url: `/part/${n}`,
      sha256: hash(bytes),
      bytes: bytes.length,
    })),
  }
  const start = async (message: object) =>
    page.evaluate((message) => {
      const worker = new Worker('/worker.js', { type: 'module' })
      const updates: { fraction?: number; done?: boolean; error?: string }[] =
        []
      Object.assign(window, { updates })
      worker.onmessage = ({ data }) => updates.push(data)
      worker.postMessage(message)
    }, message)
  await page.goto(origin)
  await start({ source: { chunks: [asset], tensors: {} } })
  await expect.poll(() => requests[2]).toBe(1)
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (await caches.open('resumable-test')).keys()).length,
      ),
    )
    .toBe(2)
  // Kill the page while the third piece has arrived only partly.
  hold = false
  await page.reload()
  expect(
    await page.evaluate(
      async () => (await (await caches.open('resumable-test')).keys()).length,
    ),
  ).toBe(2)
  await start({ source: { chunks: [asset], tensors: {} } })
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { updates: { done?: boolean }[] }).updates.some(
          (update) => update.done,
        ),
      ),
    )
    .toBe(true)
  expect(requests).toEqual([1, 1, 2, 1])
  const first = await page.evaluate(
    () =>
      (window as unknown as { updates: { fraction?: number }[] }).updates[0]
        .fraction,
  )
  expect(first).toBe(0.5)
  const saved = await page.evaluate(async (digest) => {
    const cache = await caches.open('resumable-test')
    const response = await cache.match(
      new URL(`/__model_cache/${digest}`, location.origin).href,
    )
    const bytes = await response!.arrayBuffer()
    return {
      keys: (await cache.keys()).length,
      hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    }
  }, asset.sha256)
  expect(saved).toEqual({ keys: 1, hash: asset.sha256 })
  const file = {
    url: '/tokenizer.json',
    sha256: hash(tokenizer),
    bytes: tokenizer.length,
    parts: [
      {
        url: '/tokenizer.gz',
        sha256: hash(compressed),
        bytes: compressed.length,
        compression: 'gzip',
        decodedBytes: tokenizer.length,
      },
    ],
  }
  await start({ file })
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { updates: { done?: boolean }[] }).updates.some(
          (update) => update.done,
        ),
      ),
    )
    .toBe(true)
  expect(
    await page.evaluate(async (file) => {
      const cache = await caches.open('resumable-test')
      const response = await cache.match(
        new URL(`${file.url}?sha256=${file.sha256}`, location.origin).href,
      )
      return (await response!.arrayBuffer()).byteLength
    }, file),
  ).toBe(tokenizer.length)
})
