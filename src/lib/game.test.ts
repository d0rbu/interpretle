import { describe, expect, it } from 'vitest'
import { feature } from '../../tests/fixture'
import { segments } from '../components/Heatmap'
import { calibration } from './scoring'
import {
  bandsForScore,
  bestScore,
  choices,
  createGame,
  customRemaining,
  dayNumber,
  measure,
  playCustom,
  playPassage,
  restoreGame,
  scoreLabel,
  serializeGame,
  status,
  utcDay,
} from './game'

const initial = () => createGame('daily', '2026-10-18', feature.id)
const tokens = (text: string, activation: number) => [
  { id: 42, start: 0, end: text.length, activation },
]

describe('measured game', () => {
  it('has a free median clue and a deterministic first deck', () => {
    expect(measure(feature, feature.starter.tokens).score).toBe(50)
    expect(bestScore(initial())).toBe(0)
    expect(initial().guesses).toHaveLength(0)
    expect(choices(initial(), feature)).toEqual(choices(initial(), feature))
    expect(
      choices(initial(), feature)
        .map((p) => p.band)
        .sort((a, b) => a - b),
    ).toEqual([0, 0, 0, 50, 90, 95, 99])
  })

  it.each([
    [0, [0, 0, 0, 50, 90, 95, 99]],
    [1, [0, 0, 50, 90, 95, 99, 99.9]],
    [50, [0, 50, 90, 95, 99, 99.9, 99.9]],
    [90, [0, 90, 95, 99, 99.9, 99.9, 99.9]],
    [95, [0, 95, 99, 99, 99.9, 99.9, 99.9]],
    [99, [0, 95, 99, 99.9, 99.9, 99.9, 99.9]],
  ])('uses the requested distribution at %s', (score, bands) =>
    expect(bandsForScore(score as number)).toEqual(bands),
  )

  it('scores raw activations, not the nominal sampling band', () => {
    const card = choices(initial(), feature).find((p) => p.band === 50)!
    const measured = {
      ...feature,
      passages: feature.passages.map((p) =>
        p.id === card.id ? { ...p, tokens: tokens(p.text, 5038) } : p,
      ),
    }
    expect(playPassage(initial(), measured, card.id).guesses[0].score).toBe(
      50.37,
    )
  })

  it('does not round a near miss into a win', () => {
    const near = playCustom(
      initial(),
      feature,
      'A near miss.',
      tokens('A near miss.', 9990),
    )
    expect(bestScore(near)).toBe(99.89)
    expect(status(near)).toBe('playing')
    const won = playCustom(
      near,
      feature,
      'A winning test.',
      tokens('A winning test.', 9991),
    )
    expect(status(won)).toBe('won')
    expect(choices(won, feature)).toEqual([])
    expect(() =>
      playCustom(won, feature, 'Extra.', tokens('Extra.', 1)),
    ).toThrow('finished')
    expect(scoreLabel(99.89999)).toBe('99.89th percentile')
  })

  it('enforces eight attempts and two custom submissions without charging errors', () => {
    let game = initial()
    expect(() => playCustom(game, feature, '', [])).toThrow('Write')
    expect(game.guesses).toHaveLength(0)
    for (const text of ['First.', 'Second.'])
      game = playCustom(game, feature, text, tokens(text, 0))
    expect(customRemaining(game)).toBe(0)
    expect(() =>
      playCustom(game, feature, 'Third.', tokens('Third.', 0)),
    ).toThrow('both')
    while (game.guesses.length < 8)
      game = playPassage(
        game,
        feature,
        choices(game, feature).find((p) => p.band === 0)!.id,
      )
    expect(status(game)).toBe('lost')
    expect(choices(game, feature)).toEqual([])
  })

  it('validates character limits, token offsets, and finite activations', () => {
    const text = '😁'.repeat(280)
    expect(
      playCustom(initial(), feature, text, tokens(text, 0)).guesses,
    ).toHaveLength(1)
    expect(() =>
      playCustom(initial(), feature, text + 'a', tokens(text, 0)),
    ).toThrow('280')
    expect(() =>
      playCustom(initial(), feature, 'Invalid.', tokens('Invalid.', NaN)),
    ).toThrow('invalid')
    expect(() =>
      playCustom(initial(), feature, 'Invalid.', [
        { id: 2, start: 0.5, end: 3, activation: 1 },
      ]),
    ).toThrow('invalid')
    expect(() => playPassage(initial(), feature, 'not-offered')).toThrow(
      'current round',
    )
  })

  it('keeps decks full and never offers a previously played passage', () => {
    for (let seed = 0; seed < 80; seed++) {
      let game = createGame('practice', String(seed), feature.id)
      const played = new Set<string>()
      while (status(game) === 'playing') {
        const deck = choices(game, feature)
        expect(deck).toHaveLength(7)
        expect(new Set(deck.map((p) => p.id)).size).toBe(7)
        expect(deck.some((p) => played.has(p.id))).toBe(false)
        const card = deck[seed % deck.length]
        game = playPassage(game, feature, card.id)
        played.add(card.id)
      }
    }
  })

  it('replays saved moves and recomputes their ranks', () => {
    let game = playPassage(
      initial(),
      feature,
      choices(initial(), feature)[0].id,
    )
    game = playCustom(
      game,
      feature,
      'A custom sentence.',
      tokens('A custom sentence.', 5010),
    )
    expect(restoreGame(serializeGame(game), initial(), feature)).toEqual(game)
    const bad = JSON.parse(serializeGame(game))
    bad.moves[1].tokens[0].end = 9999
    expect(restoreGame(JSON.stringify(bad), initial(), feature)).toEqual(
      initial(),
    )
  })

  it('keeps saved guesses when a layout change offers different passages', () => {
    const offered = new Set(choices(initial(), feature).map((p) => p.id))
    const previous = feature.passages.find((p) => !offered.has(p.id))!
    const saved = {
      ...JSON.parse(serializeGame(initial())),
      moves: [{ kind: 'passage', passageId: previous.id }],
    }
    const restored = restoreGame(JSON.stringify(saved), initial(), feature)
    expect(restored.guesses).toHaveLength(1)
    expect(restored.guesses[0].passageId).toBe(previous.id)
    expect(restored.guesses[0].tokens).toEqual(previous.tokens)
    saved.moves.push(saved.moves[0])
    expect(restoreGame(JSON.stringify(saved), initial(), feature)).toEqual(
      initial(),
    )
  })
})

describe('scoring and display', () => {
  it('excludes zero from the reference and uses strict lower ranks for ties', () => {
    const reference = calibration([0, 0, 1, 2, 2, 4])
    expect(reference.positiveCount).toBe(4)
    expect(reference.percentile(0)).toBe(0)
    expect(reference.percentile(2)).toBe(25)
    expect(reference.percentile(5)).toBe(100)
    expect(scoreLabel(0, false)).toBe('Inactive')
    expect(scoreLabel(0, true)).not.toBe('Inactive')
  })

  it('rejects invalid references', () => {
    for (const values of [[], [0, 0], [NaN], [-1], [Infinity]])
      expect(() => calibration(values)).toThrow()
  })

  it('preserves Unicode text and overlapping byte-fallback tokens', () => {
    const text = 'A café 😁.'
    const parts = segments(text, [
      { id: 1, start: 0, end: 1, activation: 0 },
      { id: 2, start: 2, end: 6, activation: 1 },
      { id: 3, start: 7, end: 9, activation: 2 },
      { id: 4, start: 7, end: 9, activation: 3 },
    ])
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.find((p) => p.text === '😁')?.tokens).toHaveLength(2)
  })

  it('numbers puzzles from launch and observes UTC boundaries', () => {
    expect(dayNumber('2026-10-16', '2026-10-16')).toBe(1)
    expect(dayNumber('2026-10-18', '2026-10-16')).toBe(3)
    expect(utcDay(new Date('2026-10-17T19:30:00-05:00'))).toBe('2026-10-18')
  })
})
