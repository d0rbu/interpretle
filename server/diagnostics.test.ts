import { expect, it } from 'vitest'
import {
  breadcrumb,
  diagnosticText,
  runtimeReport,
} from '../src/lib/diagnostics'
import type { Breadcrumb } from '../src/lib/diagnostics'
import { errorFingerprint, validReport } from './diagnostics'

it('keeps original errors, causes and worker locations through serialization', () => {
  const original = new TypeError('Could not allocate tensor', {
    cause: new Error('GPU memory exhausted'),
  })
  const report = runtimeReport(
    {
      error: original,
      filename: 'https://interpretle.com/assets/model-worker.js',
      lineno: 12,
      colno: 4,
    },
    'Layer 7 MLP',
    'worker',
  )
  expect(report).toMatchObject({
    name: 'TypeError',
    message: original.message,
    stack: original.stack,
    line: 12,
    column: 4,
  })
  expect(report.cause).toContain('GPU memory exhausted')
  expect(validReport(JSON.parse(JSON.stringify(report)))).toBe(true)
  const forwarded = runtimeReport(
    Object.assign(new Error('Recovery instructions'), { report }),
    'Different wrapper',
    'model',
  )
  expect(forwarded).toEqual(report)
})

it('does not present a recovery wrapper as a missing browser stack', () => {
  const cause = Object.assign(new TypeError('Internal error'), {
    stack: undefined,
  })
  const original = runtimeReport(
    cause,
    'Saving model download to browser storage',
    'model',
    {
      storageOperation: 'CacheStorage.put',
      storageAttempts: 3,
      operationStack:
        'Error: CacheStorage.put requested here\n at downloadAsset (https://interpretle.com/assets/worker.js:20:4)',
    },
  )
  expect(original.stack).toBeUndefined()
  expect(original.captureStack).toBeTruthy()
  const wrapped = Object.assign(new Error(cause.message, { cause }), {
    report: original,
  })
  const forwarded = runtimeReport(wrapped, 'Model initialization', 'model')
  expect(forwarded).toMatchObject(original)
  expect(forwarded.stack).toBeUndefined()
  expect(forwarded.captureStack).toBe(original.captureStack)
  expect(forwarded.operationStack).toBe(original.operationStack)
  expect(validReport(JSON.parse(JSON.stringify(forwarded)))).toBe(true)
})

it('retains longer original call chains within the report size limit', () => {
  function descend(depth: number): Error {
    return depth ? descend(depth - 1) : new Error('Deep failure')
  }
  const report = runtimeReport(descend(24), 'Runtime', 'model')
  expect(report.stack?.match(/at descend/g)?.length).toBe(25)
  expect(validReport(report)).toBe(true)
})

it('bounds payloads, strips URL credentials/query strings, and keeps no arbitrary error properties', () => {
  const cause = Object.assign(
    new Error(
      'Read https://user:password@example.com/model?token=secret#private Bearer secret-key',
    ),
    { stack: 'x'.repeat(20000), draft: 'Never inspect this property' },
  )
  const report = runtimeReport(cause, 'startup', 'window', {
    elapsedMs: 1.2,
    operationStack:
      'https://user:password@example.com/model?token=secret#private\n' +
      'x'.repeat(20000),
  })
  expect(report.message).toBe(
    'Read https://example.com/model Bearer [redacted]',
  )
  expect(report.stack).toHaveLength(12000)
  expect(report.operationStack).toHaveLength(12000)
  expect(JSON.stringify(report)).not.toMatch(
    /password|token=|secret-key|Never inspect/,
  )
  expect(report.elapsedMs).toBe(1)
  expect(validReport(report)).toBe(true)
  expect(diagnosticText('https://example.com/test?a=1', 100)).toBe(
    'https://example.com/test',
  )
})

it('keeps a bounded chronological breadcrumb trail', () => {
  const trail: Breadcrumb[] = []
  for (let n = 0; n < 40; n++) breadcrumb(trail, `Layer ${n}`)
  breadcrumb(trail, 'Layer 39')
  expect(trail).toHaveLength(24)
  expect(trail[0].stage).toBe('Layer 16')
  expect(
    validReport(runtimeReport(undefined, 'Unknown', 'model', { trail })),
  ).toBe(true)
})

it('groups changing build hashes, line offsets, layers and memory sizes but distinguishes operations/backends', async () => {
  const report = (layer: number, bytes: number, hash: string, line: number) =>
    runtimeReport(
      {
        name: 'Error',
        message: `Cannot allocate ${bytes} bytes`,
        stack: `Error\n at run (https://interpretle.com/assets/worker-${hash}.js:${line}:20)`,
      },
      `Layer ${layer}/22 MLP`,
      'model',
    )
  const first = await errorFingerprint(
    report(2, 12000, 'abcdefgh', 20),
    'out_of_memory',
    'gpu',
  )
  expect(
    await errorFingerprint(
      report(9, 14000, 'ijklmnop', 40),
      'out_of_memory',
      'gpu',
    ),
  ).toBe(first)
  expect(
    await errorFingerprint(
      report(2, 12000, 'abcdefgh', 20),
      'out_of_memory',
      'cpu',
    ),
  ).not.toBe(first)
  expect(
    await errorFingerprint(
      { ...report(2, 12000, 'abcdefgh', 20), stage: 'Layer 2 attention' },
      'out_of_memory',
      'gpu',
    ),
  ).not.toBe(first)
})

it('rejects malformed diagnostics and unbounded fields', () => {
  const report = runtimeReport(new Error('test'), 'Runtime', 'model')
  for (const changes of [
    { source: 'other' },
    { release: '' },
    { extra: 'not allowed' },
    { stack: 'x'.repeat(12001) },
    { operationStack: 'x'.repeat(12001) },
    { line: -1 },
    { threads: 1.5 },
    { tokens: 10001 },
    { online: 'yes' },
    { trail: Array(25).fill({ at: '', stage: 'x' }) },
    { trail: [{ at: 'not a timestamp', stage: 'x' }] },
    { trail: [{ at: new Date().toISOString(), stage: 'x', input: 'no' }] },
  ])
    expect(validReport({ ...report, ...changes })).toBe(false)
})
