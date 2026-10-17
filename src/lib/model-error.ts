// The runtime can reject with a string or numeric code, not just an Error.
export function modelError(cause: unknown, stage: string) {
  let detail =
    cause && typeof cause === 'object' && 'message' in cause
      ? String(cause.message)
      : typeof cause === 'string'
        ? cause
        : typeof cause === 'number'
          ? `Runtime error code ${cause}.`
          : ''
  const name = cause instanceof Error ? cause.name : ''
  let hint = ''
  if (/QuotaExceededError|quota.*exceed/i.test(`${name} ${detail}`))
    hint = ' Free browser storage, then retry.'
  else if (/out of memory|allocation failed|cannot allocate/i.test(detail))
    hint = ' Close other tabs or apps, then retry.'
  else if (/device.*lost/i.test(detail))
    hint = ' Reload the page to reconnect to the GPU.'
  else if (/failed to fetch|networkerror|load failed/i.test(detail))
    hint = ' Check your connection or content blocker, then retry.'
  if (hint && !/[.!?]$/.test(detail)) detail += '.'
  return `${stage} failed: ${detail || 'The browser did not report a reason. Reload to retry.'}${hint}`
}
