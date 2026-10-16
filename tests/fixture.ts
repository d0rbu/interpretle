import type { Band, Catalog, Feature, Passage } from '../src/lib/types'

// Numerical fixtures belong to tests only; the site loads measured puzzle packs.
function passage(band: Band, index: number): Passage {
  const text = `Passage ${band} number ${index}.`
  return {
    id: `p-${band}-${index}`,
    text,
    band,
    before: 'Preceding source context. ',
    source: {
      title: 'Test source',
      url: 'https://example.com',
      license: 'CC0',
    },
    tokens: [
      {
        id: 42,
        start: 0,
        end: text.length,
        activation: band === 0 ? 0 : band * 100 + 1,
      },
    ],
  }
}

export const feature: Feature = {
  id: 'test-feature',
  kind: 'sae',
  index: 42,
  title: 'A test feature',
  description: 'Used to verify game behavior.',
  reference: Array.from({ length: 10000 }, (_, i) => i + 1),
  displayScale: 9991,
  starter: passage(50, 99),
  passages: ([0, 50, 90, 95, 99, 99.9] as Band[]).flatMap((band) =>
    Array.from({ length: 24 }, (_, i) => passage(band, i)),
  ),
}

export const catalog: Catalog = {
  version: 'test',
  firstDay: '2026-10-16',
  daily: Object.fromEntries(
    ['16', '17', '18', '19'].map((day) => [`2026-10-${day}`, feature.id]),
  ),
  practice: [feature.id],
}
