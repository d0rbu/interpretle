import { expect, it } from 'vitest'
import { feature, catalog } from '../../tests/fixture'
import { choices, createGame, playCustom, playPassage } from './game'
import { gameSnapshot } from './replay'

it('preserves the exact board, model identity, and submitted token scores without copying the encoder or reference corpus', () => {
  const game = createGame('daily', '2026-10-18', feature.id)
  const initial = gameSnapshot(game, feature, catalog)
  expect(initial.options).toEqual(choices(game, feature))
  expect(initial.feature.starter).toEqual(feature.starter)
  expect(initial.feature).not.toHaveProperty('reference')
  expect(initial.feature).not.toHaveProperty('encoder')
  expect(initial.model.model_revision).toHaveLength(40)
  const picked = initial.options[0]
  const next = playPassage(game, feature, picked.id)
  const input = 'A café.'
  const tokens = [{ id: 5, start: 0, end: input.length, activation: 0.5 }]
  const custom = playCustom(next, feature, input, tokens, true)
  const replay = JSON.parse(
    JSON.stringify(gameSnapshot(custom, feature, catalog)),
  )
  expect(replay.game.guesses[0].text).toBe(picked.text)
  expect(replay.game.guesses[1]).toMatchObject({
    text: input,
    tokens,
    approximate: true,
  })
  expect(replay.options).toEqual(choices(custom, feature))
  expect(initial.game.guesses).toEqual([])
})
