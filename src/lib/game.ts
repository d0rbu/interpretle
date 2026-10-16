import { calibration } from './scoring'
import type {
  Band,
  Feature,
  Game,
  Guess,
  Mode,
  Passage,
  TokenActivation,
} from './types'

export const MAX_GUESSES = 8
export const MAX_CUSTOM = 2
export const MAX_CUSTOM_LENGTH = 280
export const WIN_SCORE = 99.9

export function hash(text: string): number {
  let value = 2166136261
  for (const char of text)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619)
  return value >>> 0
}

function random(seed: string): () => number {
  let state = hash(seed)
  return () => {
    state += 0x6d2b79f5
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10)
export const dayNumber = (day: string, firstDay: string) =>
  Math.round((Date.parse(day) - Date.parse(firstDay)) / 86400000) + 1
export const dateLabel = (day: string) =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`))

// Truncate display precision so a near miss never appears to have won.
export function scoreLabel(score: number, active = true): string {
  if (!active) return 'Inactive'
  if (score > 0 && score < 0.01) return '<0.01 percentile'
  const value = Math.floor(score * 100 + 1e-8) / 100
  const suffix =
    Number.isInteger(value) && value % 100 !== 11 && value % 10 === 1
      ? 'st'
      : Number.isInteger(value) && value % 100 !== 12 && value % 10 === 2
        ? 'nd'
        : Number.isInteger(value) && value % 100 !== 13 && value % 10 === 3
          ? 'rd'
          : 'th'
  return `${value}${suffix} percentile`
}

export const createGame = (
  mode: Mode,
  seed: string,
  featureId: string,
): Game => ({ version: 2, mode, seed, featureId, guesses: [] })
export const bestScore = (game: Game) =>
  Math.max(0, ...game.guesses.map((guess) => guess.score))
export const status = (game: Game) =>
  bestScore(game) >= WIN_SCORE
    ? 'won'
    : game.guesses.length >= MAX_GUESSES
      ? 'lost'
      : 'playing'
export const customRemaining = (game: Game) =>
  MAX_CUSTOM - game.guesses.filter((guess) => guess.kind === 'custom').length

export function bandsForScore(score: number): Band[] {
  if (score <= 0) return [0, 0, 0, 0, 50, 90, 95, 99]
  if (score < 50) return [0, 0, 0, 50, 90, 95, 99, 99.9]
  if (score < 90) return [0, 0, 50, 90, 95, 99, 99.9, 99.9]
  if (score < 95) return [0, 50, 90, 95, 99, 99.9, 99.9, 99.9]
  if (score < 99) return [0, 90, 95, 99, 99, 99.9, 99.9, 99.9]
  return [0, 95, 99, 99, 99.9, 99.9, 99.9, 99.9]
}

export function choices(game: Game, feature: Feature): Passage[] {
  if (status(game) !== 'playing') return []
  const shown = new Set<string>()
  const played = new Set<string>()
  let best = 0
  for (let round = 0; round <= game.guesses.length; round++) {
    const next = random(`${feature.id}:${game.seed}:${round}`)
    const selected = new Set<string>()
    const cards = bandsForScore(best).map((band) => {
      const eligible = feature.passages.filter(
        (p) => p.band === band && !selected.has(p.id) && !played.has(p.id),
      )
      const fresh = eligible.filter((p) => !shown.has(p.id))
      const pool = fresh.length ? fresh : eligible
      if (!pool.length) throw new Error(`No passages remain in band ${band}.`)
      const card = pool[Math.floor(next() * pool.length)]
      selected.add(card.id)
      return card
    })
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[cards[i], cards[j]] = [cards[j], cards[i]]
    }
    if (round === game.guesses.length) return cards
    cards.forEach((card) => shown.add(card.id))
    const guess = game.guesses[round]
    if (guess.passageId) played.add(guess.passageId)
    best = Math.max(best, guess.score)
  }
  return []
}

export function measure(feature: Feature, tokens: TokenActivation[]) {
  const rawMax = Math.max(0, ...tokens.map((token) => token.activation))
  return { rawMax, score: calibration(feature.reference).percentile(rawMax) }
}

function addGuess(game: Game, guess: Guess): Game {
  if (status(game) !== 'playing')
    throw new Error('This puzzle is already finished.')
  return { ...game, guesses: [...game.guesses, guess] }
}

export function playPassage(
  game: Game,
  feature: Feature,
  passageId: string,
): Game {
  const passage = choices(game, feature).find((item) => item.id === passageId)
  if (!passage) throw new Error('Choose a passage from the current round.')
  return addGuess(game, {
    kind: 'passage',
    passageId,
    text: passage.text,
    tokens: passage.tokens,
    ...measure(feature, passage.tokens),
  })
}

export function validateCustom(game: Game, input: string): string {
  if (status(game) !== 'playing')
    throw new Error('This puzzle is already finished.')
  if (!customRemaining(game))
    throw new Error('You have used both custom sentences.')
  const text = input.trim()
  if (!text) throw new Error('Write a sentence first.')
  if (Array.from(text).length > MAX_CUSTOM_LENGTH)
    throw new Error(`Use ${MAX_CUSTOM_LENGTH} characters or fewer.`)
  if (
    game.guesses.some(
      (guess) => guess.text.toLowerCase() === text.toLowerCase(),
    )
  )
    throw new Error('You have already tried that sentence.')
  return text
}

export function playCustom(
  game: Game,
  feature: Feature,
  input: string,
  tokens: TokenActivation[],
): Game {
  const text = validateCustom(game, input)
  if (
    !tokens.length ||
    tokens.some(
      (t) =>
        !Number.isFinite(t.activation) ||
        t.activation < 0 ||
        !Number.isInteger(t.id) ||
        t.id < 0 ||
        !Number.isInteger(t.start) ||
        !Number.isInteger(t.end) ||
        t.start < 0 ||
        t.end <= t.start ||
        t.end > text.length,
    )
  )
    throw new Error('The local model returned invalid token activations.')
  return addGuess(game, {
    kind: 'custom',
    text,
    tokens,
    ...measure(feature, tokens),
  })
}

export const storageKey = (game: Pick<Game, 'mode' | 'seed' | 'featureId'>) =>
  `interpretle:2:${game.mode}:${game.seed}:${game.featureId}`

export function serializeGame(game: Game): string {
  return JSON.stringify({
    version: 2,
    mode: game.mode,
    seed: game.seed,
    featureId: game.featureId,
    moves: game.guesses.map((guess) =>
      guess.kind === 'passage'
        ? { kind: 'passage', passageId: guess.passageId }
        : { kind: 'custom', text: guess.text, tokens: guess.tokens },
    ),
  })
}

// Stored passages replay from the published data. Custom activations stay local;
// we validate their shape and recompute scores without reloading model weights.
export function restoreGame(
  saved: string | null,
  initial: Game,
  feature: Feature,
): Game {
  if (!saved || saved.length > 200000) return initial
  try {
    const data = JSON.parse(saved)
    if (
      data.version !== 2 ||
      data.mode !== initial.mode ||
      data.seed !== initial.seed ||
      data.featureId !== feature.id ||
      !Array.isArray(data.moves) ||
      data.moves.length > MAX_GUESSES
    )
      return initial
    return data.moves.reduce((game: Game, move: Guess) => {
      if (move.kind === 'passage' && typeof move.passageId === 'string')
        return playPassage(game, feature, move.passageId)
      if (
        move.kind === 'custom' &&
        typeof move.text === 'string' &&
        Array.isArray(move.tokens)
      )
        return playCustom(game, feature, move.text, move.tokens)
      throw new Error('Invalid saved move.')
    }, initial)
  } catch {
    return initial
  }
}

export function shareText(game: Game, firstDay: string): string {
  const number =
    game.mode === 'daily' ? dayNumber(game.seed, firstDay) : 'Practice'
  const result = status(game) === 'won' ? game.guesses.length : 'X'
  const squares = game.guesses
    .map(({ score, rawMax }) =>
      rawMax === 0
        ? '⬜'
        : score < 50
          ? '🟨'
          : score < 95
            ? '🟧'
            : score < WIN_SCORE
              ? '🟩'
              : '✨',
    )
    .join('')
  return `interpretle ${number} · ${result}/${MAX_GUESSES}\n${squares}\nhttps://interpretle.com`
}
