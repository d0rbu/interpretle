import type { Game } from './types'
import { puzzleDay } from './day'
import { isStorageFull } from './model-error'
import type { ModelDiagnostics } from './model-error'
import type { GameSnapshot } from './replay'
import { breadcrumb, runtimeReport } from './diagnostics'
import type { Breadcrumb, RuntimeReport } from './diagnostics'

export const EVENTS = [
  'visit',
  'theme',
  'puzzle_view',
  'game_start',
  'guess',
  'guess_submit',
  'finish',
  'writein_open',
  'context',
  'share',
  'model_start',
  'model_ready',
  'model_error',
  'client_error',
  'model_cancel',
] as const
export const THEMES = ['light', 'dark', 'system'] as const
export const PROBLEMS = [
  'network',
  'storage',
  'webgpu',
  'memory',
  'runtime',
] as const
export type EventFields = Partial<ModelDiagnostics> & {
  theme?: 'light' | 'dark'
  themePreference?: (typeof THEMES)[number]
  mode?: Game['mode']
  round?: string
  feature?: string
  passage?: string
  slot?: number
  band?: number
  attempt?: number
  outcome?: 'won' | 'lost'
  problem?: (typeof PROBLEMS)[number]
  cores?: number
  memoryGb?: number
  touchPoints?: number
  submission?: string
  text?: string
  expanded?: boolean
  snapshot?: GameSnapshot
  report?: RuntimeReport
}
let player: string | undefined,
  visit: string | undefined,
  page: string | undefined
let currentTheme: Pick<EventFields, 'theme' | 'themePreference'> = {}
let currentGame: Pick<EventFields, 'mode' | 'round' | 'feature'> = {}
const sent = new Set<string>()
const OUTBOX = 'interpretle:event:'
const pending = new Map<string, string>()
let initialized = false,
  sending = false
let queued = Promise.resolve()
let retry: ReturnType<typeof setTimeout> | undefined
let sequence = 0
const trail: Breadcrumb[] = []
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function identity(kind: 'localStorage' | 'sessionStorage', key: string) {
  const id = crypto.randomUUID()
  try {
    const storage = globalThis[kind]
    const value = storage.getItem(key)
    if (value && uuid.test(value)) return value
    storage.setItem(key, id)
  } catch {
    /* Use an in-memory ID when storage is blocked. */
  }
  return id
}

function identify() {
  player ??= identity('localStorage', 'interpretle:visitor')
  visit ??= identity('sessionStorage', 'interpretle:visit')
  page ??= crypto.randomUUID()
}

function persist(id: string, body?: string) {
  try {
    // One key per event avoids overwriting another tab's pending submissions.
    if (body === undefined) localStorage.removeItem(OUTBOX + id)
    else localStorage.setItem(OUTBOX + id, body)
  } catch {
    // Keep the in-memory queue when browser storage is unavailable/full.
  }
}

async function flush() {
  if (sending) return
  clearTimeout(retry)
  sending = true
  try {
    for (const [id, body] of pending) {
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Browsers cap all outstanding keepalive bodies at 64 KiB.
        keepalive: new TextEncoder().encode(body).length < 60_000,
        body,
      })
      if (!response.ok && ![400, 413, 415].includes(response.status)) break
      pending.delete(id)
      persist(id)
    }
  } catch {
    // Retry the same IDs; the server deduplicates uncertain deliveries.
  } finally {
    sending = false
    if (pending.size && typeof window !== 'undefined')
      retry = setTimeout(() => void flush(), 5000)
  }
}

function initialize() {
  if (initialized) return
  initialized = true
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(OUTBOX)) continue
      const id = key.slice(OUTBOX.length),
        body = localStorage.getItem(key)
      if (/^[a-f0-9]{64}$/.test(id) && body && body.length <= 262144)
        pending.set(id, body)
    }
    sequence = Number(sessionStorage.getItem('interpretle:event-sequence')) || 0
  } catch {
    /* Start with an empty queue if storage is blocked or damaged. */
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void flush())
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void flush()
    })
  }
  void flush()
}

export function setAnalyticsGame(game?: Game) {
  currentGame = game
    ? { mode: game.mode, round: game.seed, feature: game.featureId }
    : {}
}

/** First-party event history. Inputs are recorded only on submission. */
export function track(
  event: (typeof EVENTS)[number],
  fields: EventFields = {},
  key: string = crypto.randomUUID(),
) {
  try {
    identify()
    initialize()
    if (sent.has(key)) return
    sent.add(key)
    const browser = player
    const at = new Date().toISOString()
    const order = ++sequence
    try {
      sessionStorage.setItem('interpretle:event-sequence', String(order))
    } catch {
      /* In-memory order still works. */
    }
    const context = { ...currentTheme, ...currentGame, ...fields }
    const failure = event === 'model_error' || event === 'client_error'
    if (context.report)
      context.report = runtimeReport(null, '', context.report.source, {
        ...context.report,
        isolated: globalThis.crossOriginIsolated === true,
        online: navigator.onLine !== false,
        visible: typeof document === 'undefined' || !document.hidden,
        trail: [...trail, ...(context.report.trail ?? [])]
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(-24),
      })
    if (!failure)
      breadcrumb(
        trail,
        [event, context.mode, context.attempt && `guess ${context.attempt}`]
          .filter(Boolean)
          .join(' · '),
      )
    const memory = failure
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined
    const device = failure
      ? {
          cores:
            navigator.hardwareConcurrency > 0
              ? navigator.hardwareConcurrency
              : undefined,
          memoryGb:
            memory && Number.isFinite(memory) && memory > 0
              ? memory
              : undefined,
          touchPoints: navigator.maxTouchPoints,
        }
      : {}
    const digest = crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${browser}:${key}`),
    )
    queued = queued
      .then(() => digest)
      .then((bytes) => {
        const id = Array.from(new Uint8Array(bytes), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('')
        const body = JSON.stringify({
          id,
          player: browser,
          visit,
          sequence: order,
          at,
          event,
          ...context,
          ...device,
        })
        pending.set(id, body)
        persist(id, body)
        void flush()
      })
      .catch(() => {})
  } catch {
    /* Counters must never interrupt the game. */
  }
}

export function startErrorTracking() {
  window.addEventListener('error', (event) => {
    track('client_error', {
      problem: 'runtime',
      report: runtimeReport(event, 'Page execution', 'window', {
        elapsedMs: Math.round(performance.now()),
      }),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    track('client_error', {
      problem: 'runtime',
      report: runtimeReport(event.reason, 'Unhandled promise', 'promise', {
        elapsedMs: Math.round(performance.now()),
      }),
    })
  })
}

export function trackVisit() {
  // Session storage survives reloads; another tab gets a separate visit.
  identify()
  track('visit', {}, `${puzzleDay()}:visit:${visit}`)
}

/** Count each selected/displayed combination once per visit and Pacific day. */
export function trackTheme(
  preference: (typeof THEMES)[number],
  systemDark: boolean,
) {
  identify()
  const theme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  currentTheme = { themePreference: preference, theme }
  track(
    'theme',
    { themePreference: preference, theme },
    `${puzzleDay()}:theme:${visit}:${preference}:${theme}`,
  )
}

export function trackGame(
  event: (typeof EVENTS)[number],
  game: Game,
  fields: EventFields = {},
) {
  identify()
  const round = `${game.mode}:${game.seed}:${game.featureId}`
  track(
    event,
    { mode: game.mode, round: game.seed, feature: game.featureId, ...fields },
    `${event === 'puzzle_view' ? `${puzzleDay()}:${visit}:${page}:` : ''}${round}:${event}:${fields.attempt ?? ''}:${fields.submission ?? ''}`,
  )
}

export function modelProblem(error: unknown): (typeof PROBLEMS)[number] {
  const report = (error as { report?: RuntimeReport } | null)?.report
  const message = report
    ? `${report.name} ${report.message}`
    : error instanceof Error
      ? `${error.name} ${error.message}`
      : String(error)
  if (isStorageFull(error) || /storage|quota|cache/i.test(message))
    return 'storage'
  if (/download|fetch|network|HTTP|integrity/i.test(message)) return 'network'
  if (/out of memory|allocation|cannot allocate/i.test(message)) return 'memory'
  if (/WebGPU|shader-f16|GPU.*(?:support|lost)|16-bit float/i.test(message))
    return 'webgpu'
  return 'runtime'
}
