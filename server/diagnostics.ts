import {
  REPORT_NUMBER_LIMITS,
  REPORT_SOURCES,
  REPORT_TEXT_LIMITS,
} from '../src/lib/diagnostics'
import type { RuntimeReport } from '../src/lib/diagnostics'

export function validReport(value: unknown): value is RuntimeReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as RuntimeReport
  const keys = [
    ...Object.keys(REPORT_TEXT_LIMITS),
    ...Object.keys(REPORT_NUMBER_LIMITS),
    'source',
    'isolated',
    'online',
    'visible',
    'trail',
  ]
  if (Object.keys(report).some((key) => !keys.includes(key))) return false
  if (!REPORT_SOURCES.includes(report.source)) return false
  for (const key of ['name', 'message', 'stage', 'release'] as const)
    if (typeof report[key] !== 'string' || !report[key]) return false
  for (const [key, limit] of Object.entries(REPORT_TEXT_LIMITS)) {
    const text = report[key as keyof typeof REPORT_TEXT_LIMITS]
    if (text !== undefined && (typeof text !== 'string' || text.length > limit))
      return false
  }
  for (const [key, limit] of Object.entries(REPORT_NUMBER_LIMITS)) {
    const number = report[key as keyof typeof REPORT_NUMBER_LIMITS]
    if (
      number !== undefined &&
      (!Number.isInteger(number) || number < 0 || number > limit)
    )
      return false
  }
  for (const key of ['isolated', 'online', 'visible'] as const)
    if (report[key] !== undefined && typeof report[key] !== 'boolean')
      return false
  return (
    report.trail === undefined ||
    (Array.isArray(report.trail) &&
      report.trail.length <= 24 &&
      report.trail.every(
        (step) =>
          step &&
          Object.keys(step).every((key) => ['at', 'stage'].includes(key)) &&
          typeof step.at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(step.at) &&
          Number.isFinite(Date.parse(step.at)) &&
          typeof step.stage === 'string' &&
          step.stage.length <= 240,
      ))
  )
}

// Group changing addresses, asset hashes, layer numbers and memory sizes into
// one issue. Keep the operation, backend and HTTP status distinct.
export async function errorFingerprint(
  report: RuntimeReport,
  code: string = 'unknown',
  backend: string = 'unknown',
  httpStatus?: number,
) {
  const normalize = (value: string) =>
    value
      .replace(/https?:\/\/[^\s)]+/g, (url) => url.replace(/[?#].*$/, ''))
      .replace(/-[\w-]{8,}(?=\.m?js\b)/g, '-BUILD')
      .replace(/:\d+:\d+/g, ':LINE:COL')
      .replace(/0x[\da-f]+|\b\d{4,}\b/gi, '#')
      .replace(/\blayer\s+\d+(?:\/\d+)?/gi, 'layer #')
  const firstFrame =
    report.stack?.split('\n').find((line) => /\bat\b|@/.test(line)) ?? ''
  const text = [
    report.source,
    report.name,
    normalize(report.message),
    normalize(report.stage),
    normalize(firstFrame),
    code,
    backend,
    httpStatus ?? '',
  ].join('\n')
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
