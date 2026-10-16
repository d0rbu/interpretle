import { describe, expect, it } from 'vitest'
import { FEATURES, getFeature } from '../data/demo'
import {
  MAX_GUESSES,
  bandsForScore,
  bestScore,
  choices,
  createGame,
  customRemaining,
  demoTokens,
  playCustom,
  playPassage,
  restoreGame,
  serializeGame,
  shareText,
  status,
  utcDay,
} from './game'
import { calibration } from './scoring'

describe('puzzle rules', () => {
  it('gives every player the same daily starter and shuffled first round', () => {
    const a = createGame('daily', '2026-10-16')
    const b = createGame('daily', '2026-10-16')
    expect(a).toEqual(b)
    expect(choices(a)).toEqual(choices(b))
    expect(
      choices(a)
        .map((p) => p.band)
        .sort((a, b) => a - b),
    ).toEqual([0, 0, 0, 0, 50, 90, 95, 99])
    const starter = getFeature(a.featureId).starter
    expect(starter.band).toBe(50)
    expect(
      Math.max(
        ...demoTokens(starter.text, 50, a.featureId).map((t) => t.percentile),
      ),
    ).toBe(50)
    expect(a.guesses).toHaveLength(0)
    expect(bestScore(a)).toBe(0)
  })

  it.each([
    [0, [0, 0, 0, 0, 50, 90, 95, 99]],
    [0.01, [0, 0, 0, 50, 90, 95, 99, 99.9]],
    [49.9, [0, 0, 0, 50, 90, 95, 99, 99.9]],
    [50, [0, 0, 50, 90, 95, 99, 99.9, 99.9]],
    [90, [0, 50, 90, 95, 99, 99.9, 99.9, 99.9]],
    [95, [0, 90, 95, 99, 99, 99.9, 99.9, 99.9]],
    [99, [0, 95, 99, 99, 99.9, 99.9, 99.9, 99.9]],
  ])('uses the requested score schedule at %s', (score, expected) => {
    expect(bandsForScore(score as number)).toEqual(expected)
  })

  it('ends immediately at 99.9 and rejects extra moves', () => {
    let game = createGame('daily', '2026-10-16')
    game = playPassage(game, choices(game).find((p) => p.band === 99)!.id)
    game = playPassage(game, choices(game).find((p) => p.band === 99.9)!.id)
    expect(status(game)).toBe('won')
    expect(bestScore(game)).toBe(99.9)
    expect(choices(game)).toEqual([])
    expect(() => playCustom(game, 'another guess')).toThrow('finished')
    expect(shareText(game)).toContain('2/8')
    expect(shareText(game)).not.toContain(getFeature(game.featureId).title)
  })

  it('finishes after eight unsuccessful attempts and keeps the best score', () => {
    let game = createGame('practice', 'eight-rounds')
    game = playPassage(game, choices(game).find((p) => p.band === 95)!.id)
    for (let i = 1; i < MAX_GUESSES; i++)
      game = playPassage(game, choices(game).find((p) => p.band === 0)!.id)
    expect(game.guesses).toHaveLength(8)
    expect(bestScore(game)).toBe(95)
    expect(status(game)).toBe('lost')
    expect(choices(game)).toEqual([])
    expect(shareText(game)).toContain('X/8')
  })

  it('enforces the shared attempt budget and the two-custom quota', () => {
    let game = createGame('practice', 'custom-limit')
    game = playCustom(game, 'An ordinary red bicycle.')
    game = playCustom(game, 'A green chair beside the desk.')
    expect(game.guesses).toHaveLength(2)
    expect(customRemaining(game)).toBe(0)
    expect(() => playCustom(game, 'A third sentence.')).toThrow('both custom')
    expect(choices(game)).toHaveLength(8)
  })

  it('does not spend an attempt on invalid, duplicate, or unoffered inputs', () => {
    const game = createGame('practice', 'input-validation')
    expect(() => playCustom(game, ' \n\t ')).toThrow('Write a sentence')
    expect(() => playCustom(game, 'a'.repeat(281))).toThrow('280')
    expect(() => playPassage(game, 'not-in-this-deck')).toThrow('current round')
    const next = playCustom(game, ' A blue chair. ')
    expect(() => playCustom(next, 'a BLUE chair.')).toThrow('already tried')
    expect(game.guesses).toHaveLength(0)
    expect(next.guesses).toHaveLength(1)
  })

  it('keeps all decks full, unique, hidden by ordering, and free of played cards across seeds', () => {
    for (let seed = 0; seed < 120; seed++) {
      let game = createGame('practice', `simulation-${seed}`)
      const played = new Set<string>()
      while (status(game) === 'playing') {
        const deck = choices(game)
        expect(deck).toHaveLength(8)
        expect(new Set(deck.map((p) => p.id)).size).toBe(8)
        expect(deck.some((p) => played.has(p.id))).toBe(false)
        const eligible = deck.filter((p) => p.band < 99.9)
        const chosen = eligible[(seed + game.guesses.length) % eligible.length]
        played.add(chosen.id)
        game = playPassage(game, chosen.id)
      }
      expect(status(game)).toBe('lost')
    }
  })

  it('preserves text exactly in demo heatmaps and exposes the maximum score', () => {
    for (const feature of FEATURES)
      for (const passage of [feature.starter, ...feature.passages]) {
        const tokens = demoTokens(passage.text, passage.band, feature.id)
        expect(tokens.map((t) => t.text).join('')).toBe(passage.text)
        expect(Math.max(...tokens.map((t) => t.percentile))).toBe(passage.band)
        expect(
          tokens.every(
            (t) => t.activation >= 0 && t.percentile <= passage.band,
          ),
        ).toBe(true)
      }
  })
})

describe('saved games', () => {
  it('replays moves to recover scores, deck, and custom quota', () => {
    let game = createGame('daily', '2026-10-16')
    game = playCustom(game, 'A green chair by the window.')
    game = playPassage(game, choices(game)[0].id)
    const restored = restoreGame(serializeGame(game), 'daily', '2026-10-16')!
    expect(restored).toEqual(game)
    expect(choices(restored)).toEqual(choices(game))
    expect(customRemaining(restored)).toBe(1)
  })

  it('discards corrupt, mismatched, over-budget, and stale daily saves', () => {
    const game = createGame('daily', '2026-10-16')
    expect(restoreGame('{', 'daily', game.seed)).toBeNull()
    expect(restoreGame('null', 'daily', game.seed)).toBeNull()
    expect(restoreGame(serializeGame(game), 'daily', '2026-10-17')).toBeNull()
    expect(restoreGame(serializeGame(game), 'practice', game.seed)).toBeNull()
    const corrupt = JSON.stringify({
      version: 1,
      mode: 'daily',
      seed: game.seed,
      moves: Array(9).fill({ kind: 'custom', text: 'test' }),
    })
    expect(restoreGame(corrupt, 'daily', game.seed)).toBeNull()
  })

  it('changes the daily key at midnight UTC irrespective of local timezone', () => {
    expect(utcDay(new Date('2026-10-16T18:59:59-05:00'))).toBe('2026-10-16')
    expect(utcDay(new Date('2026-10-16T19:00:00-05:00'))).toBe('2026-10-17')
  })
})

describe('real-score calibration contract', () => {
  it('excludes zero passages and uses strict lower ranks for positive ties', () => {
    const reference = calibration([0, 0, 0, 1, 2, 2, 4])
    expect(reference.positiveCount).toBe(4)
    expect(reference.inactiveCount).toBe(3)
    expect(reference.percentile(0)).toBe(0)
    expect(reference.percentile(1)).toBe(0)
    expect(reference.percentile(2)).toBe(25)
    expect(reference.percentile(4)).toBe(75)
    expect(reference.percentile(5)).toBe(100)
  })

  it('keeps an empirical 99.9 threshold distinct from rounded lower scores', () => {
    const reference = calibration(
      Array.from({ length: 10000 }, (_, i) => i + 1),
    )
    expect(reference.percentile(9990)).toBe(99.89)
    expect(reference.percentile(9991)).toBe(99.9)
    expect(reference.percentile(9990) < 99.9).toBe(true)
  })

  it('rejects invalid or never-active calibration data', () => {
    for (const values of [[], [0, 0], [1, NaN], [1, -1], [Infinity]])
      expect(() => calibration(values)).toThrow()
    const reference = calibration([1])
    expect(reference.percentile(1)).toBe(0)
    expect(() => reference.percentile(NaN)).toThrow()
    expect(() => reference.percentile(-1)).toThrow()
  })
})
