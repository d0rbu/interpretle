import type { GameSnapshot } from '../src/lib/replay'
import type { Passage, TokenActivation } from '../src/lib/types'

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value: unknown) => number(value) && Number.isSafeInteger(value)
const tokens = (value: TokenActivation[], content: string) =>
  Array.isArray(value) &&
  value.length <= 512 &&
  value.every(
    (token) =>
      token &&
      integer(token.id) &&
      integer(token.start) &&
      integer(token.end) &&
      token.end > token.start &&
      token.end <= content.length &&
      number(token.activation),
  )
const passage = (value: Passage) =>
  value &&
  text(value.id, 100) &&
  text(value.text, 4096) &&
  text(value.before, 4096) &&
  [0, 50, 90, 95, 99, 99.9].includes(value.band) &&
  tokens(value.tokens, value.text)

// Recorded scores are client-reported diagnostics, not trusted competition results.
// Bound the board and token data before retaining a submitted game snapshot.
export function validSnapshot(
  value: unknown,
  expected: { mode: string; round: string; feature: string },
) {
  if (!value || typeof value !== 'object') return false
  const s = value as GameSnapshot
  return (
    s.version === 1 &&
    s.rules &&
    s.rules.customLimit === 2 &&
    s.rules.winPercentile === 99.9 &&
    ['playing', 'won', 'lost'].includes(s.status) &&
    text(s.catalog, 100) &&
    s.model &&
    Object.values(s.model).length === 5 &&
    Object.values(s.model).every((v) => text(v, 200)) &&
    (s.manifest === null ||
      (text(s.manifest, 250) && s.manifest.startsWith('/model/'))) &&
    s.feature &&
    s.feature.id === expected.feature &&
    ['sae', 'mlp', 'neuron'].includes(s.feature.kind) &&
    integer(s.feature.index) &&
    text(s.feature.title, 200) &&
    text(s.feature.description, 4000) &&
    number(s.feature.displayScale) &&
    passage(s.feature.starter) &&
    s.starterScore &&
    number(s.starterScore.rawMax) &&
    number(s.starterScore.score) &&
    s.starterScore.score <= 100 &&
    s.game &&
    s.game.version === 2 &&
    [6, 8].includes(s.game.maxGuesses) &&
    s.game.mode === expected.mode &&
    s.game.seed === expected.round &&
    s.game.featureId === expected.feature &&
    Array.isArray(s.game.guesses) &&
    s.game.guesses.length <= s.game.maxGuesses &&
    s.game.guesses.filter((g) => g?.kind === 'custom').length <= 2 &&
    s.game.guesses.every(
      (g) =>
        g &&
        ['passage', 'custom'].includes(g.kind) &&
        text(g.text, 4096) &&
        (g.kind === 'custom'
          ? Array.from(g.text).length <= 280
          : text(g.passageId, 100)) &&
        tokens(g.tokens, g.text) &&
        number(g.rawMax) &&
        number(g.score) &&
        g.score <= 100 &&
        (g.approximate === undefined || typeof g.approximate === 'boolean'),
    ) &&
    Array.isArray(s.options) &&
    s.options.length <= 5 &&
    s.options.every(passage)
  )
}
