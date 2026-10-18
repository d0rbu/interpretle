import { expect, it } from 'vitest'
import { isStorageFull, modelDiagnostics, modelError } from './model-error'
import { modelProblem } from './analytics'

it('preserves runtime rejections that are not Error instances', () => {
  expect(modelError('Unsupported GPU operation: MatMul', 'Model setup')).toBe(
    'Model setup failed: Unsupported GPU operation: MatMul',
  )
  expect(modelError(1234, 'Scoring layer 7')).toContain('1234')
  expect(
    modelError(
      { message: 'Uncaught shader compilation error' },
      'Model worker',
    ),
  ).toContain('Uncaught shader compilation error')
  expect(
    modelError(
      {
        message: '',
        error: new TypeError('Tokenizer cache could not be read'),
      },
      'Tokenizer vocabulary download',
    ),
  ).toContain('Tokenizer cache could not be read')
  expect(
    modelError({ type: 'error', code: 23 }, 'Tokenizer initialization'),
  ).toContain('type: error, code: 23')
  expect(
    modelError(
      new DOMException('', 'NotSupportedError'),
      'Tokenizer initialization',
    ),
  ).toContain('NotSupportedError')
})

it('keeps the cause and adds recovery advice for known failures', () => {
  expect(modelError(new TypeError('Failed to fetch'), 'Model download')).toBe(
    'Model download failed: Failed to fetch. Check your connection or content blocker, then retry.',
  )
  expect(
    modelError(
      new DOMException('Quota exceeded', 'QuotaExceededError'),
      'Cache',
    ),
  ).toContain('Free browser storage')
  expect(modelError('GPU out of memory', 'Scoring layer 12')).toContain(
    'Close other tabs or apps',
  )
  expect(modelError('GPU device was lost', 'Scoring')).toContain(
    'reconnect to the GPU',
  )
})

it.each(['QuotaExceededError', 'NS_ERROR_FILE_NO_DEVICE_SPACE'])(
  'explains %s and counts it as storage rather than a network failure',
  (name) => {
    const cause = new DOMException('', name)
    const message = modelError(cause, 'Tokenizer vocabulary download')
    expect(message).toContain('Browser model storage is full')
    expect(message).toContain('Completed downloads are kept')
    expect(isStorageFull(cause)).toBe(true)
    expect(modelProblem(cause)).toBe('storage')
    expect(modelProblem(new Error(message))).toBe('storage')
  },
)

it('does not invent a cause when the browser provides none', () => {
  expect(modelError(undefined, 'Model worker')).toContain(
    'The browser did not report a reason',
  )
})

it('identifies Safari native cache failures as storage errors without claiming disk is full', () => {
  const cause = Object.assign(new Error('Internal error'), {
    report: {
      name: 'TypeError',
      message: 'Internal error',
      storageOperation: 'CacheStorage.put',
    },
  })
  expect(
    modelDiagnostics(cause, 'Saving model download to browser storage', 'gpu'),
  ).toMatchObject({ code: 'storage_unavailable', phase: 'storage' })
  expect(modelProblem(cause)).toBe('storage')
  expect(modelError(cause, 'Saving model download')).toContain(
    'Retry to resume saved downloads',
  )
  expect(modelError(cause, 'Saving model download')).not.toContain(
    'storage is full',
  )
})

it('classifies the original cross-worker failure rather than its recovery wrapper', () => {
  const wrapped = Object.assign(new Error('Preparing model weights failed'), {
    report: {
      name: 'NS_ERROR_FILE_NO_DEVICE_SPACE',
      message: 'Cache write failed',
    },
  })
  expect(
    modelDiagnostics(wrapped, 'Reading layer 4 weights', 'gpu'),
  ).toMatchObject({ code: 'storage_full', phase: 'weights', layer: 4 })
  expect(modelProblem(wrapped)).toBe('storage')
})

it.each([
  [
    new DOMException('', 'NS_ERROR_FILE_NO_DEVICE_SPACE'),
    'Tokenizer vocabulary download',
    'storage_full',
    'tokenizer',
  ],
  [
    new Error('HTTP 503 fetching model data'),
    'Model weight download',
    'http',
    'weights',
  ],
  [
    new TypeError('Failed to fetch'),
    'Model manifest download',
    'network',
    'manifest',
  ],
  [
    new Error('GPU device was lost'),
    'Layer 12/22 attention',
    'gpu_lost',
    'inference',
  ],
  [
    new Error('Cannot allocate memory: out of memory'),
    'Layer 7/22',
    'out_of_memory',
    'inference',
  ],
  [
    new Error('Model checksum integrity failure'),
    'Model data download',
    'integrity',
    'download',
  ],
  [
    new Error('Tokenizer rejected "PRIVATE INPUT"'),
    'Text tokenization',
    'tokenizer',
    'tokenizer',
  ],
  [
    new Error('This sentence exceeds 127 model tokens'),
    'Text tokenization',
    'invalid_input',
    'tokenizer',
  ],
  [
    new Error('The model returned non-finite values'),
    'Scoring',
    'non_finite',
    'inference',
  ],
  [undefined, 'Model worker', 'worker', 'worker'],
])('reports safe diagnostics for %s', (cause, stage, code, phase) => {
  const result = modelDiagnostics(cause, stage as string, 'cpu')
  expect(result).toMatchObject({ code, phase, backend: 'cpu' })
  expect(JSON.stringify(result)).not.toContain('PRIVATE INPUT')
  expect(result).not.toHaveProperty('message')
})

it('preserves HTTP status and layer as numbers without exporting raw messages', () => {
  expect(
    modelDiagnostics(
      new Error('HTTP 502 at a private URL'),
      'Layer 4/22',
      'gpu',
    ),
  ).toEqual({
    code: 'http',
    phase: 'inference',
    backend: 'gpu',
    httpStatus: 502,
    layer: 4,
  })
})
