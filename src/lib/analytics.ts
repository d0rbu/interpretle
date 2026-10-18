import type { Game } from './types'
import { puzzleDay } from './day'
import { isStorageFull } from './model-error'
import type { ModelDiagnostics } from './model-error'

export const EVENTS = [
  'visit',
  'theme',
  'puzzle_view',
  'game_start',
  'guess',
  'finish',
  'writein_open',
  'share',
  'model_start',
  'model_ready',
  'model_error',
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
}
let player: string | undefined, visit: string | undefined
let currentTheme: Pick<EventFields, 'theme' | 'themePreference'> = {}
const sent = new Set<string>()
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
}

/** First-party counters only. Never accept text, tokens, or raw error messages. */
export function track(
  event: (typeof EVENTS)[number],
  fields: EventFields = {},
  key: string = crypto.randomUUID(),
) {
  try {
    identify()
    if (sent.has(key)) return
    sent.add(key)
    const browser = player
    const theme = currentTheme
    const memory =
      event === 'model_error'
        ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
        : undefined
    const device =
      event === 'model_error'
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
    void digest
      .then((bytes) =>
        fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            id: Array.from(new Uint8Array(bytes), (b) =>
              b.toString(16).padStart(2, '0'),
            ).join(''),
            player: browser,
            event,
            ...theme,
            ...fields,
            ...device,
          }),
        }),
      )
      .catch(() => {})
  } catch {
    /* Counters must never interrupt the game. */
  }
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
    `${event === 'puzzle_view' ? `${puzzleDay()}:${visit}:` : ''}${round}:${event}:${fields.attempt ?? ''}`,
  )
}

export function modelProblem(error: unknown): (typeof PROBLEMS)[number] {
  const message =
    error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (isStorageFull(error) || /storage|quota|cache/i.test(message))
    return 'storage'
  if (/download|fetch|network|HTTP|integrity/i.test(message)) return 'network'
  if (/out of memory|allocation|cannot allocate/i.test(message)) return 'memory'
  if (/WebGPU|shader-f16|GPU.*(?:support|lost)|16-bit float/i.test(message))
    return 'webgpu'
  return 'runtime'
}
