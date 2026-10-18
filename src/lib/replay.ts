import model from '../../data/model.json'
import { choices, measure, status, MAX_CUSTOM, WIN_SCORE } from './game'
import type { Catalog, Feature, Game } from './types'

// Save the rendered board and scores, not the large calibration/encoder arrays.
// Keeping the actual options also preserves replays when selection rules change.
export function gameSnapshot(game: Game, feature: Feature, catalog: Catalog) {
  return {
    version: 1 as const,
    catalog: catalog.version,
    model,
    manifest: catalog.browserModel?.manifest ?? null,
    feature: {
      id: feature.id,
      kind: feature.kind,
      index: feature.index,
      title: feature.title,
      description: feature.description,
      displayScale: feature.displayScale,
      starter: feature.starter,
    },
    starterScore: measure(feature, feature.starter.tokens),
    rules: { customLimit: MAX_CUSTOM, winPercentile: WIN_SCORE },
    status: status(game),
    game,
    options: choices(game, feature),
  }
}

export type GameSnapshot = ReturnType<typeof gameSnapshot>
