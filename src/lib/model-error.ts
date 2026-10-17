// Browser APIs can reject with DOM events, nested errors, strings, or codes.
function errorDetail(cause: unknown, depth = 0): string {
  if (typeof cause === 'string') return cause.trim()
  if (typeof cause === 'number') return `Runtime error code ${cause}.`
  if (!cause || typeof cause !== 'object') return ''
  const value = cause as Record<string, unknown>
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
  const name =
    cause && typeof cause === 'object' && 'name' in cause ? cause.name : ''
  return /QuotaExceededError|quota.*(?:exceed|reach)|NS_ERROR_FILE_NO_DEVICE_SPACE|ENOSPC|no space left on device/i.test(
    `${name} ${errorDetail(cause)}`,
  )
}

export function modelError(cause: unknown, stage: string) {
  let detail = errorDetail(cause)
  let hint = ''
  if (isStorageFull(cause))
    return `${stage} failed: Browser model storage is full. Free browser storage or disk space, then retry. Completed downloads are kept.`
  else if (/out of memory|allocation failed|cannot allocate/i.test(detail))
    hint = ' Close other tabs or apps, then retry.'
  else if (/device.*lost/i.test(detail))
    hint = ' Reload the page to reconnect to the GPU.'
  else if (/failed to fetch|networkerror|load failed/i.test(detail))
    hint = ' Check your connection or content blocker, then retry.'
  if (hint && !/[.!?]$/.test(detail)) detail += '.'
  return `${stage} failed: ${detail || 'The browser did not report a reason. Reload to retry.'}${hint}`
}
