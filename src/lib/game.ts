import { FEATURES, getFeature } from '../data/demo'
import type { Band, Game, Guess, Mode, Passage, TokenActivation } from './types'

export const MAX_GUESSES = 8
export const MAX_CUSTOM = 2
export const MAX_CUSTOM_LENGTH = 280
export const WIN_SCORE = 99.9
export const DATA_VERSION = 'demo-1'

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

function shuffle<T>(items: T[], next: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function createGame(mode: Mode, seed: string): Game {
  return {
    version: 1,
    id: `${DATA_VERSION}:${mode}:${seed}`,
    seed,
    mode,
    featureId: FEATURES[hash(seed) % FEATURES.length].id,
    guesses: [],
  }
}

export function bestScore(game: Game): number {
  return Math.max(0, ...game.guesses.map((guess) => guess.score))
}

export function status(game: Game): 'playing' | 'won' | 'lost' {
  if (bestScore(game) >= WIN_SCORE) return 'won'
  return game.guesses.length >= MAX_GUESSES ? 'lost' : 'playing'
}

export function customRemaining(game: Game): number {
  return (
    MAX_CUSTOM - game.guesses.filter((guess) => guess.kind === 'custom').length
  )
}

// Boundaries are lower-inclusive. The free starter does not advance this schedule.
export function bandsForScore(score: number): Band[] {
  if (score <= 0) return [0, 0, 0, 0, 50, 90, 95, 99]
  if (score < 50) return [0, 0, 0, 50, 90, 95, 99, 99.9]
  if (score < 90) return [0, 0, 50, 90, 95, 99, 99.9, 99.9]
  if (score < 95) return [0, 50, 90, 95, 99, 99.9, 99.9, 99.9]
  if (score < 99) return [0, 90, 95, 99, 99, 99.9, 99.9, 99.9]
  return [0, 95, 99, 99, 99.9, 99.9, 99.9, 99.9]
}

export function choices(game: Game): Passage[] {
  if (status(game) !== 'playing') return []
  const feature = getFeature(game.featureId)
  const previouslyShown = new Set<string>()
  const previouslyPlayed = new Set<string>()
  let best = 0
  for (let round = 0; round <= game.guesses.length; round++) {
    const next = random(`${game.seed}:${round}:${DATA_VERSION}`)
    const selected = new Set<string>()
    const cards = bandsForScore(best).map((band) => {
      const eligible = feature.passages.filter(
        (p) =>
          p.band === band && !selected.has(p.id) && !previouslyPlayed.has(p.id),
      )
      const fresh = eligible.filter((p) => !previouslyShown.has(p.id))
      const pool = fresh.length ? fresh : eligible
      if (!pool.length)
        throw new Error(`Demo passage pool exhausted for band ${band}.`)
      const card = pool[Math.floor(next() * pool.length)]
      selected.add(card.id)
      return card
    })
    const ordered = shuffle(cards, next)
    if (round === game.guesses.length) return ordered
    cards.forEach((card) => previouslyShown.add(card.id))
    const guess = game.guesses[round]
    if (guess.passageId) previouslyPlayed.add(guess.passageId)
    best = Math.max(best, guess.score)
  }
  return []
}

// Illustrative word segments, not Gemma tokenizer output. Real scoring must supply
// measured token activations and offsets through the contract in docs/scoring.md.
export function demoTokens(
  text: string,
  score: number,
  featureId: string,
): TokenActivation[] {
  const feature = getFeature(featureId)
  const parts = text.match(/\s+|[^\s]+/gu) ?? []
  let strengths = parts.map((part) =>
    feature.cue.test(part) ? 0.65 + (hash(part) % 35) / 100 : 0,
  )
  if (score > 0 && !strengths.some(Boolean)) {
    const longest = parts.reduce(
      (best, part, i) => (part.length > parts[best].length ? i : best),
      0,
    )
    strengths = parts.map((_, i) => (i === longest ? 1 : 0))
  }
  const maximum = Math.max(1e-9, ...strengths)
  return parts.map((part, i) => {
    const percentile =
      Math.round(((score * strengths[i]) / maximum) * 100) / 100
    return { text: part, activation: percentile / 10, percentile }
  })
}

function addGuess(game: Game, guess: Guess): Game {
  if (status(game) !== 'playing')
    throw new Error('This puzzle is already finished.')
  return { ...game, guesses: [...game.guesses, guess] }
}

export function playPassage(game: Game, passageId: string): Game {
  const passage = choices(game).find((item) => item.id === passageId)
  if (!passage) throw new Error('Choose a passage from the current round.')
  return addGuess(game, {
    kind: 'passage',
    passageId,
    text: passage.text,
    score: passage.band,
    tokens: demoTokens(passage.text, passage.band, game.featureId),
  })
}

export function playCustom(game: Game, input: string): Game {
  if (status(game) !== 'playing')
    throw new Error('This puzzle is already finished.')
  if (customRemaining(game) <= 0)
    throw new Error('You have used both custom sentences.')
  const text = input.trim().replace(/\s+/gu, ' ')
  if (!text) throw new Error('Write a sentence first.')
  if (Array.from(text).length > MAX_CUSTOM_LENGTH)
    throw new Error(`Use ${MAX_CUSTOM_LENGTH} characters or fewer.`)
  if (
    game.guesses.some(
      (guess) => guess.text.toLowerCase() === text.toLowerCase(),
    )
  ) {
    throw new Error('You have already tried that sentence.')
  }
  const words = text.match(/[\p{L}’']+/gu) ?? []
  const cue = getFeature(game.featureId).cue
  const matched = new Set(
    words.filter((word) => cue.test(word)).map((word) => word.toLowerCase()),
  ).size
  // Explicitly a toy lexical scorer for testing the interaction; no model call.
  const scores = [0, 40, 65, 85, 94, 98, 99, 99.5, 99.9]
  const score = scores[Math.min(matched, scores.length - 1)]
  return addGuess(game, {
    kind: 'custom',
    text,
    score,
    tokens: demoTokens(text, score, game.featureId),
  })
}

export function shareText(game: Game): string {
  const result = status(game) === 'won' ? game.guesses.length : 'X'
  const squares = game.guesses
    .map(({ score }) =>
      score === 0
        ? '⬜'
        : score < 50
          ? '🟨'
          : score < 95
            ? '🟧'
            : score < 99.9
              ? '🟩'
              : '✨',
    )
    .join('')
  return `Interpretle · Demo ${game.mode === 'daily' ? game.seed : 'Practice'}\n${result}/${MAX_GUESSES} · ${bestScore(game)}th percentile\n${squares}\ninterpretle.com`
}

export function storageKey(mode: Mode, day: string): string {
  return `interpretle:${DATA_VERSION}:${mode}:${mode === 'daily' ? day : 'current'}`
}

export function serializeGame(game: Game): string {
  return JSON.stringify({
    version: 1,
    mode: game.mode,
    seed: game.seed,
    moves: game.guesses.map((guess) =>
      guess.kind === 'passage'
        ? { kind: 'passage', passageId: guess.passageId }
        : { kind: 'custom', text: guess.text },
    ),
  })
}

// Replay actions rather than trusting persisted scores, quotas, or feature IDs.
export function restoreGame(
  saved: string | null,
  mode: Mode,
  seed: string,
): Game | null {
  if (!saved || saved.length > 12000) return null
  try {
    const data = JSON.parse(saved)
    if (
      data.version !== 1 ||
      data.mode !== mode ||
      typeof data.seed !== 'string' ||
      data.seed.length > 100 ||
      (mode === 'daily' && data.seed !== seed) ||
      !Array.isArray(data.moves) ||
      data.moves.length > MAX_GUESSES
    )
      return null
    let game = createGame(mode, data.seed)
    for (const move of data.moves) {
      if (move.kind === 'passage' && typeof move.passageId === 'string')
        game = playPassage(game, move.passageId)
      else if (move.kind === 'custom' && typeof move.text === 'string')
        game = playCustom(game, move.text)
      else return null
    }
    return game
  } catch {
    return null
  }
}
