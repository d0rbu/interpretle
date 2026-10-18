// Browser APIs can reject with DOM events, nested errors, strings, or codes.
function errorDetail(cause: unknown, depth = 0): string {
  if (typeof cause === 'string') return cause.trim()
  if (typeof cause === 'number') return `Runtime error code ${cause}.`
  if (!cause || typeof cause !== 'object') return ''
  const value = cause as Record<string, unknown>
  if (value.report && typeof value.report === 'object' && depth < 2)
    return errorDetail(value.report, depth + 1)
  const nested = value.error ?? value.cause ?? value.reason
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  if (message) return message
  if (nested !== undefined && nested !== cause && depth < 2) {
    const detail = errorDetail(nested, depth + 1)
    if (detail) return detail
  }
  return ['name', 'type', 'code', 'status']
    .filter((key) => ['string', 'number'].includes(typeof value[key]))
    .map((key) => `${key}: ${value[key]}`)
    .join(', ')
}

export function isStorageFull(cause: unknown) {
  const value = cause as { name?: unknown; report?: { name?: unknown } } | null
  const name = value?.report?.name ?? value?.name ?? ''
  return /QuotaExceededError|quota.*(?:exceed|reach)|NS_ERROR_FILE_NO_DEVICE_SPACE|ENOSPC|no space left on device/i.test(
    `${name} ${errorDetail(cause)}`,
  )
}

export function isStorageError(cause: unknown) {
  return (
    isStorageFull(cause) ||
    Boolean(
      (cause as { report?: { storageOperation?: string } } | null)?.report
        ?.storageOperation,
    ) ||
    /storage|quota|cache|failed writing data to the file system/i.test(
      errorDetail(cause),
    )
  )
}

export const MODEL_BACKENDS = ['unknown', 'cpu', 'gpu'] as const
export const MODEL_PHASES = [
  'unknown',
  'startup',
  'manifest',
  'storage',
  'download',
  'tokenizer',
  'runtime',
  'weights',
  'inference',
  'worker',
] as const
export const MODEL_ERROR_CODES = [
  'unknown',
  'storage_full',
  'storage_unavailable',
  'out_of_memory',
  'gpu_lost',
  'gpu_unsupported',
  'http',
  'network',
  'integrity',
  'tokenizer',
  'invalid_input',
  'non_finite',
  'worker',
  'runtime',
] as const
export type ModelDiagnostics = {
  code: (typeof MODEL_ERROR_CODES)[number]
  phase: (typeof MODEL_PHASES)[number]
  backend: (typeof MODEL_BACKENDS)[number]
  httpStatus?: number
  layer?: number
}

// Stable categories are kept separate from the bounded private exception report.
export function modelDiagnostics(
  cause: unknown,
  stage: string,
  backend: ModelDiagnostics['backend'] = 'unknown',
): ModelDiagnostics {
  const detail = errorDetail(cause)
  const httpStatus = Number(/\bHTTP\s+(\d{3})\b/i.exec(detail)?.[1])
  const layer = /\blayer\s+(\d+)\b/i.exec(stage)?.[1]
  const phase =
    (
      [
        ['tokenizer', /tokeniz/i],
        ['manifest', /manifest/i],
        ['storage', /storage|cleaning/i],
        ['weights', /weights?/i],
        ['download', /download/i],
        ['runtime', /runtime|graph/i],
        ['worker', /worker/i],
        ['inference', /layer|embedding|scor/i],
      ] as const
    ).find(([, pattern]) => pattern.test(stage))?.[0] ?? 'startup'
  const code = isStorageFull(cause)
    ? 'storage_full'
    : isStorageError(cause)
      ? 'storage_unavailable'
      : ((
          [
            [
              'storage_unavailable',
              /storage.*(?:unavailable|blocked|denied)|SecurityError/i,
            ],
            [
              'out_of_memory',
              /out of memory|allocation failed|cannot allocate|buffer budget/i,
            ],
            ['gpu_lost', /device.*lost/i],
            [
              'gpu_unsupported',
              /unsupported.*GPU|WebGPU.*(?:unavailable|support)|shader-f16/i,
            ],
            ['http', /\bHTTP\s+[1-5]\d{2}\b/i],
            ['integrity', /integrity|checksum|hash mismatch/i],
            ['network', /failed to fetch|network|download.*fail|load failed/i],
            ['non_finite', /non-finite/i],
            ['invalid_input', /exceeds.*tokens|model control tokens/i],
          ] as const
        ).find(([, pattern]) => pattern.test(detail))?.[0] ??
        (phase === 'tokenizer'
          ? 'tokenizer'
          : phase === 'worker'
            ? 'worker'
            : 'runtime'))
  return {
    code,
    phase,
    backend,
    ...(httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(layer !== undefined ? { layer: Number(layer) } : {}),
  }
}

export function modelError(cause: unknown, stage: string) {
  let detail = errorDetail(cause)
  let hint = ''
  if (isStorageFull(cause))
    return `${stage} failed: Browser model storage is full. Free browser storage or disk space, then retry. Completed downloads are kept.`
  else if (isStorageError(cause))
    return `${stage} failed: The browser could not save the model files (${detail || 'storage unavailable'}). Retry to resume saved downloads. If it keeps failing, check available device storage.`
  else if (/out of memory|allocation failed|cannot allocate/i.test(detail))
    hint = ' Close other tabs or apps, then retry.'
  else if (/device.*lost/i.test(detail))
    hint = ' Reload the page to reconnect to the GPU.'
  else if (/failed to fetch|networkerror|load failed/i.test(detail))
    hint = ' Check your connection or content blocker, then retry.'
  if (hint && !/[.!?]$/.test(detail)) detail += '.'
  return `${stage} failed: ${detail || 'The browser did not report a reason. Reload to retry.'}${hint}`
}
