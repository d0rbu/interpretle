import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  choices,
  createGame,
  hasEncodingErrors,
  measure,
  playPassage,
  sentenceCount,
  status,
} from '../lib/game'
import { calibration } from '../lib/scoring'
import { segments } from '../components/Heatmap'
import type { Catalog, Feature } from '../lib/types'

const catalog: Catalog = JSON.parse(
  readFileSync('public/puzzles/index.json', 'utf8'),
)
const curated: {
  index: number
  mode: string
  clue: string
  clueToken: string
  wins: string[]
  choices?: Record<string, string[]>
}[] = JSON.parse(readFileSync('data/features.json', 'utf8')).filter(
  (target: { mode: string }) => target.mode === 'daily',
)
const curatedIds = new Set(
  curated.map((target) => `gemma4-l21-sae-${target.index}-v4`),
)
const ids = [...new Set([...Object.values(catalog.daily), ...catalog.practice])]
const limits = new Map([
  [50, [45, 55]],
  [90, [88, 92]],
  [95, [94, 96]],
  [99, [98.5, 99.8]],
  [99.9, [99.9, 100]],
])

describe('published measurements', () => {
  it('has daily and practice puzzles and a browser model', () => {
    expect(catalog.daily[catalog.firstDay]).toBeTruthy()
    expect(catalog.practice.length).toBeGreaterThan(1)
    expect(catalog.browserModel?.bytes).toBeGreaterThan(1e9)
  })

  it('keeps experimental practice targets separate from curated daily features', () => {
    const read = (id: string): Feature =>
      JSON.parse(readFileSync(`public/puzzles/${id}.json`, 'utf8'))
    const daily = new Set(
      Object.values(catalog.daily).map((id) => {
        const feature = read(id)
        expect(feature.kind).toBe('sae')
        return feature.index
      }),
    )
    expect(curated).toHaveLength(30)
    expect(daily.size).toBeGreaterThanOrEqual(curated.length)
    const practice = catalog.practice.map(read)
    expect(practice.filter((f) => f.kind === 'sae')).toHaveLength(48)
    expect(practice.filter((f) => f.kind === 'mlp')).toHaveLength(8)
    expect(
      practice
        .filter((f) => f.kind === 'sae')
        .every((f) => !daily.has(f.index)),
    ).toBe(true)
  })

  it('pins reviewed clues and winning examples', () => {
    const scheduled = new Set(Object.values(catalog.daily))
    for (const target of curated) {
      const id = `gemma4-l21-sae-${target.index}-v4`
      expect(scheduled.has(id)).toBe(true)
      const feature: Feature = JSON.parse(
        readFileSync(`public/puzzles/${id}.json`, 'utf8'),
      )
      expect(feature.starter.id).toBe(target.clue)
      expect(typeof target.clueToken).toBe('string')
      const maximum = Math.max(
        ...feature.starter.tokens.map((token) => token.activation),
      )
      const peaks = feature.starter.tokens
        .filter((token) => token.activation === maximum)
        .map((token) =>
          feature.starter.text.slice(token.start, token.end).trim(),
        )
      expect(peaks).toContain(target.clueToken.trim())
      const wins = feature.passages.filter((passage) => passage.band === 99.9)
      expect(target.wins.length).toBeGreaterThanOrEqual(4)
      expect(new Set(wins.map((passage) => passage.id))).toEqual(
        new Set(target.wins),
      )
      expect(
        new Set(wins.map((passage) => passage.id.replace(/:\d+-\d+$/, '')))
          .size,
      ).toBe(wins.length)
      if (target.choices) {
        const selected = feature.passages.filter((p) =>
          feature.choiceIds?.includes(p.id),
        )
        expect(new Set(feature.choiceIds).size).toBe(feature.choiceIds?.length)
        expect(selected).toHaveLength(feature.choiceIds!.length)
        for (const [band, expected] of Object.entries(target.choices)) {
          const actual = selected.filter((p) => p.band === Number(band))
          expect(new Set(actual.map((p) => p.id))).toEqual(new Set(expected))
          expect(
            new Set(actual.map((p) => p.id.replace(/:\d+-\d+$/, ''))).size,
          ).toBeGreaterThanOrEqual(8)
        }
      }
    }
    expect(curated.some((target) => target.index === 9475)).toBe(false)
  })

  it('gives the date puzzle distinct activation patterns for near-misses and winners', () => {
    const feature: Feature = JSON.parse(
      readFileSync('public/puzzles/gemma4-l21-sae-959-v4.json', 'utf8'),
    )
    const months = new Set(
      'January February March April May June July August September October November December'.split(
        ' ',
      ),
    )
    const monthDate = new RegExp(
      `\\bin (?:${[...months].join('|')}) \\d{4}\\b`,
      'i',
    )
    for (const passage of feature.passages.filter(
      (p) => feature.choiceIds?.includes(p.id) && p.band >= 90,
    )) {
      const maximum = Math.max(...passage.tokens.map((t) => t.activation))
      const peaks = passage.tokens
        .filter((t) => t.activation === maximum)
        .map((t) => passage.text.slice(t.start, t.end).trim())
      if (passage.band === 99.9)
        expect(peaks.some((text) => months.has(text))).toBe(true)
      // The winning format can be distinguished from the visible text alone.
      expect(monthDate.test(passage.text)).toBe(passage.band === 99.9)
    }
  })

  for (const id of ids) {
    const feature: Feature = JSON.parse(
      readFileSync(`public/puzzles/${id}.json`, 'utf8'),
    )
    it(`${id}: valid measurements, reachable goal, and complete rounds`, () => {
      expect(feature.id).toBe(id)
      expect(feature.reference.length).toBeGreaterThanOrEqual(10000)
      expect(
        feature.reference.every(
          (value, i, values) =>
            Number.isFinite(value) &&
            value > 0 &&
            (i === 0 || value >= values[i - 1]),
        ),
      ).toBe(true)
      const reference = calibration(feature.reference)
      const scores = new Map<string, number>()
      for (const passage of [feature.starter, ...feature.passages]) {
        if (curatedIds.has(id))
          expect(passage.text).not.toMatch(
            /^\s*(?:See also|References|External links|Further reading)\s*$/m,
          )
        expect(scores.has(passage.id)).toBe(false)
        expect(passage.tokens.length).toBeGreaterThan(0)
        expect(passage.tokens.length).toBeLessThanOrEqual(80)
        expect(typeof passage.before).toBe('string')
        expect(passage).not.toHaveProperty('after')
        expect(
          passage.tokens.every(
            (token) =>
              Number.isInteger(token.id) &&
              token.id >= 0 &&
              Number.isInteger(token.start) &&
              Number.isInteger(token.end) &&
              token.start >= 0 &&
              token.start < token.end &&
              token.end <= passage.text.length &&
              Number.isFinite(token.activation) &&
              token.activation >= 0,
          ),
        ).toBe(true)
        expect(
          segments(passage.text, passage.tokens)
            .map((part) => part.text)
            .join(''),
        ).toBe(passage.text)
        const maximum = Math.max(
          ...passage.tokens.map((token) => token.activation),
        )
        const score = reference.percentile(maximum)
        scores.set(passage.id, score)
        if (maximum > 0) expect(feature.reference.includes(maximum)).toBe(true)
        if (passage.band === 0) expect(maximum).toBe(0)
        else if (passage !== feature.starter) {
          const [low, high] = limits.get(passage.band)!
          expect(score).toBeGreaterThanOrEqual(low)
          expect(score).toBeLessThan(high)
        }
      }
      const starter = measure(feature, feature.starter.tokens)
      expect(
        hasEncodingErrors(feature.starter.before + feature.starter.text),
      ).toBe(false)
      expect(starter.score).toBeGreaterThanOrEqual(
        curatedIds.has(id) ? 45 : 49.9,
      )
      expect(starter.score).toBeLessThanOrEqual(curatedIds.has(id) ? 55 : 50)
      expect(
        feature.passages.filter((p) => scores.get(p.id)! >= 99.9).length,
      ).toBeGreaterThanOrEqual(4)

      for (const aim of [0, 50, 90, 95, 99]) {
        let game = createGame('practice', `published-${aim}`, id)
        for (let round = 0; round < game.maxGuesses; round++) {
          const cards = choices(game, feature)
          expect(new Set(cards.map((p) => p.id)).size).toBe(5)
          expect(cards.every((p) => sentenceCount(p.text) <= 3)).toBe(true)
          expect(cards.some((p) => hasEncodingErrors(p.before + p.text))).toBe(
            false,
          )
          expect(
            cards.some((p) => game.guesses.some((g) => g.passageId === p.id)),
          ).toBe(false)
          const selected = cards
            .filter((p) => scores.get(p.id)! < 99.9)
            .sort(
              (a, b) =>
                Math.abs(scores.get(a.id)! - aim) -
                Math.abs(scores.get(b.id)! - aim),
            )[0]
          game = playPassage(game, feature, selected.id)
        }
        expect(status(game)).toBe('lost')
      }
    })
  }
})
