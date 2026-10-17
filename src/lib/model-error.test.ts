import { expect, it } from 'vitest'
import { isStorageFull, modelError } from './model-error'
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
