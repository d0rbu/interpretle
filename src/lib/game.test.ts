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
  hasEncodingErrors,
  measure,
  playCustom,
  playPassage,
  restoreGame,
  scoreLabel,
  scoreColor,
  scoreEmoji,
  serializeGame,
  shareText,
  status,
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
    ).toEqual([0, 0, 0, 50, 90])
  })

  it.each([
    [0, [0, 0, 0, 50, 90]],
    [49.999, [0, 0, 0, 50, 90]],
    [50, [0, 0, 50, 90, 99]],
    [89.999, [0, 0, 50, 90, 99]],
    [90, [0, 50, 90, 95, 99.9]],
    [94.999, [0, 50, 90, 95, 99.9]],
    [95, [50, 90, 95, 99, 99.9]],
    [98.999, [50, 90, 95, 99, 99.9]],
    [99, [50, 95, 99, 99.9, 99.9]],
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

  it('skips broken source encoding in passages and context without rewriting measurements', () => {
    const [first, second] = choices(initial(), feature)
    const damaged = {
      ...feature,
      passages: feature.passages.map((passage) =>
        passage.id === first.id
          ? { ...passage, text: 'The dad said â€œItâ€™s a surprise.' }
          : passage.id === second.id
            ? { ...passage, before: 'Broken quotation marks: â€œ' }
            : passage,
      ),
    }
    expect(
      choices(initial(), damaged).some((p) =>
        [first.id, second.id].includes(p.id),
      ),
    ).toBe(false)
    expect(damaged.passages.find((p) => p.id === first.id)?.tokens).toBe(
      first.tokens,
    )
    expect(hasEncodingErrors('“Café, naïve, 日本語, and 😀.”')).toBe(false)
    expect(hasEncodingErrors('A damaged \ufffd character.')).toBe(true)
  })

  it('advances by the best sampling band, including a 49.8th-percentile representative of 50', () => {
    const measured = {
      ...feature,
      passages: feature.passages.map((p) => ({
        ...p,
        tokens: tokens(p.text, p.band === 0 ? 0 : p.band * 100 - 19),
      })),
    }
    let game = initial()
    for (const band of [0, 50, 90, 95, 99]) {
      const card = choices(game, measured).find((p) => p.band === band)!
      game = playPassage(game, measured, card.id)
      expect(game.guesses.at(-1)!.score).toBeCloseTo(
        band === 0 ? 0 : band - 0.2,
      )
      if (game.guesses.length < game.maxGuesses)
        expect(
          choices(game, measured)
            .map((p) => p.band)
            .sort((a, b) => a - b),
        ).toEqual(bandsForScore(band))
      expect(restoreGame(serializeGame(game), initial(), measured)).toEqual(
        game,
      )
    }
  })

  it('keeps winning options after a weaker guess because progress uses the best band', () => {
    let game = initial()
    game = playPassage(
      game,
      feature,
      choices(game, feature).find((p) => p.band === 90)!.id,
    )
    const best = bestScore(game)
    game = playPassage(
      game,
      feature,
      choices(game, feature).find((p) => p.band === 0)!.id,
    )
    expect(bestScore(game)).toBe(best)
    expect(game.guesses.at(-1)!.score).toBe(0)
    const winning = choices(game, feature).filter((p) => p.band === 99.9)
    expect(winning).toHaveLength(1)
    expect(status(playPassage(game, feature, winning[0].id))).toBe('won')
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

  it('enforces six attempts and two custom submissions without charging errors', () => {
    let game = initial()
    expect(() => playCustom(game, feature, '', [])).toThrow('Write')
    expect(game.guesses).toHaveLength(0)
    for (const text of ['First.', 'Second.'])
      game = playCustom(game, feature, text, tokens(text, 0))
    expect(customRemaining(game)).toBe(0)
    expect(() =>
      playCustom(game, feature, 'Third.', tokens('Third.', 0)),
    ).toThrow('both')
    while (game.guesses.length < 6)
      game = playPassage(
        game,
        feature,
        choices(game, feature).find((p) => p.band === 0)!.id,
      )
    expect(status(game)).toBe('lost')
    expect(choices(game, feature)).toEqual([])
  })

  it('keeps the original limit for an older saved game that has already started', () => {
    let legacy = { ...initial(), maxGuesses: 8 as const }
    for (let i = 0; i < 7; i++)
      legacy = playPassage(
        legacy,
        feature,
        choices(legacy, feature).find((p) => p.band === 0)!.id,
      ) as typeof legacy
    const saved = JSON.parse(serializeGame(legacy))
    delete saved.maxGuesses
    const restored = restoreGame(JSON.stringify(saved), initial(), feature)
    expect(restored.maxGuesses).toBe(8)
    expect(restored.guesses).toHaveLength(7)
    expect(status(restored)).toBe('playing')
    saved.moves = []
    expect(
      restoreGame(JSON.stringify(saved), initial(), feature).maxGuesses,
    ).toBe(6)
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
        expect(deck).toHaveLength(5)
        expect(new Set(deck.map((p) => p.id)).size).toBe(5)
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

  it('retains which custom scores used the approximate model across reloads', () => {
    const game = playCustom(
      initial(),
      feature,
      'Estimated.',
      tokens('Estimated.', 5038),
      true,
    )
    expect(game.guesses[0].approximate).toBe(true)
    expect(restoreGame(serializeGame(game), initial(), feature)).toEqual(game)
    const legacy = JSON.parse(serializeGame(game))
    delete legacy.moves[0].approximate
    expect(
      restoreGame(JSON.stringify(legacy), initial(), feature).guesses[0]
        .approximate,
    ).toBe(false)
    legacy.moves[0].approximate = 'unknown'
    expect(restoreGame(JSON.stringify(legacy), initial(), feature)).toEqual(
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
  it('uses the nearest color anchor for guesses without a sampling band', () => {
    expect(
      [0, 25, 25.01, 70, 70.01, 92.5, 92.51, 97, 97.01, 99.899, 99.9, 100].map(
        (score) => scoreEmoji(score),
      ),
    ).toEqual([
      '⬜',
      '⬜',
      '🟥',
      '🟥',
      '🟧',
      '🟧',
      '🟨',
      '🟨',
      '🟩',
      '🟩',
      '✨',
      '✨',
    ])
    const game = {
      ...initial(),
      guesses: [45.98, 94.57, 88.1, 99.98].map((score) => ({
        kind: 'passage' as const,
        text: '',
        tokens: [],
        rawMax: 1,
        score,
      })),
    }
    expect(shareText(game, '2026-10-16', feature)).toBe(
      'interpretle 3 · 4/6\n🟥🟨🟧✨\nhttps://interpretle.com',
    )
  })
  it('shares a suggested passage by its sampling band, with sparkle only for actual wins', () => {
    expect(scoreEmoji(98.88, 99)).toBe('🟩')
    expect(scoreColor(98.88)).toBe('rgb(81, 154, 96)')
    expect(scoreColor(99)).toBe('rgb(77, 152, 97)')
    expect(scoreEmoji(94.57, 95)).toBe('🟨')
    expect(scoreEmoji(49.98, 50)).toBe('🟥')
    expect(scoreEmoji(99.89, 99.9)).toBe('🟩')
    expect(scoreEmoji(99.9, 99.9)).toBe('✨')
    const card = feature.passages.find((p) => p.band === 99)!
    const game = {
      ...initial(),
      guesses: [
        {
          kind: 'passage' as const,
          passageId: card.id,
          text: card.text,
          tokens: card.tokens,
          rawMax: 1,
          score: 98.88,
        },
      ],
    }
    expect(shareText(game, '2026-10-16', feature)).toContain('\n🟩\n')
  })
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

  it('numbers puzzles from launch', () => {
    expect(dayNumber('2026-10-16', '2026-10-16')).toBe(1)
    expect(dayNumber('2026-10-18', '2026-10-16')).toBe(3)
  })
})
