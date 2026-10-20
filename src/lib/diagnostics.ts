// Bounded exception reports shared by the page and its two model workers.
declare const __APP_BUILD__: string
export const appBuild =
  typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'development'
export const REPORT_SOURCES = [
  'model',
  'weights',
  'worker',
  'window',
  'promise',
] as const
export const REPORT_TEXT_LIMITS = {
  name: 120,
  message: 2000,
  stack: 12000,
  captureStack: 6000,
  cause: 3000,
  stage: 240,
  release: 100,
  filename: 500,
  manifest: 240,
  gpu: 240,
  storageOperation: 80,
  asset: 300,
} as const
export const REPORT_NUMBER_LIMITS = {
  line: 10_000_000,
  column: 10_000_000,
  elapsedMs: 604_800_000,
  threads: 1024,
  tokens: 10000,
  assetBytes: 4_000_000_000,
  storageUsageBytes: 2 ** 44,
  storageQuotaBytes: 2 ** 44,
  storageAttempts: 3,
} as const
export type Breadcrumb = { at: string; stage: string }
export type RuntimeReport = {
  source: (typeof REPORT_SOURCES)[number]
  name: string
  message: string
  stage: string
  release: string
  stack?: string
  captureStack?: string
  cause?: string
  filename?: string
  manifest?: string
  gpu?: string
  storageOperation?: string
  asset?: string
  line?: number
  column?: number
  elapsedMs?: number
  threads?: number
  tokens?: number
  assetBytes?: number
  storageUsageBytes?: number
  storageQuotaBytes?: number
  storageAttempts?: number
  isolated?: boolean
  online?: boolean
  visible?: boolean
  trail?: Breadcrumb[]
}

export function diagnosticText(value: string, limit: number) {
  return value
    .replace(/https?:\/\/[^\s<>"']+/g, (address) => {
      try {
        const url = new URL(address)
        url.username = url.password = url.search = url.hash = ''
        return url.href
      } catch {
        return address
      }
    })
    .replace(/\b(Bearer|Basic)\s+[\w+/=.-]+/gi, '$1 [redacted]')
    .slice(0, limit)
}

export function runtimeReport(
  cause: unknown,
  stage: string,
  source: RuntimeReport['source'],
  context: Partial<RuntimeReport> = {},
): RuntimeReport {
  const value =
    cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : {}
  const nested = value.error ?? value.reason
  const error =
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)
      : value
  const fallback = ['name', 'type', 'code', 'status']
    .filter((key) => ['string', 'number'].includes(typeof error[key]))
    .map((key) => `${key}: ${error[key]}`)
    .join(', ')
  const message =
    error.message ||
    value.message ||
    nested ||
    (typeof cause === 'string' || typeof cause === 'number'
      ? String(cause)
      : fallback) ||
    'No reason reported'
  const report: RuntimeReport = {
    source,
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: String(message),
    stage,
    release: appBuild,
    // A forwarded report owns the original stack, even when none was supplied.
    // Do not replace that absence with the stack of a recovery wrapper.
    ...(typeof error.stack === 'string' && !value.report
      ? { stack: error.stack }
      : {}),
    ...(error.cause !== undefined
      ? {
          cause:
            error.cause instanceof Error
              ? (error.cause.stack ?? error.cause.message)
              : String(error.cause),
        }
      : {}),
    ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
    ...(typeof value.lineno === 'number' ? { line: value.lineno } : {}),
    ...(typeof value.colno === 'number' ? { column: value.colno } : {}),
    ...(value.report as RuntimeReport | undefined),
    ...context,
  }
  if (!report.stack && !report.captureStack)
    report.captureStack = new Error(
      'Capture site; original stack unavailable',
    ).stack
  for (const [key, limit] of Object.entries(REPORT_TEXT_LIMITS)) {
    const field = key as keyof typeof REPORT_TEXT_LIMITS
    if (report[field] !== undefined)
      report[field] = diagnosticText(report[field]!, limit)
  }
  if (report.trail)
    report.trail = report.trail.slice(-24).map(({ at, stage }) => ({
      at,
      stage: diagnosticText(stage, 240),
    }))
  for (const [key, maximum] of Object.entries(REPORT_NUMBER_LIMITS)) {
    const field = key as keyof typeof REPORT_NUMBER_LIMITS
    if (report[field] !== undefined)
      report[field] = Math.min(maximum, Math.max(0, Math.round(report[field]!)))
  }
  return report
}

export function breadcrumb(trail: Breadcrumb[], stage: string) {
  if (trail.at(-1)?.stage === stage) return
  trail.push({ at: new Date().toISOString(), stage: stage.slice(0, 240) })
  if (trail.length > 24) trail.shift()
}
