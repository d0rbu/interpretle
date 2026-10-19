import type { Sql } from './analytics'
import { escape as e } from './admin'
import type { Band } from '../src/lib/types'

export type FlowGroup = {
  guesses: number
  limit: number
  fromStart: number
  outcome: 'won' | 'lost' | 'open'
  count: number
  bands?: (Band | null)[]
}

const bands: Band[] = [0, 50, 90, 95, 99, 99.9]
function scoreBand(value: { band?: number; score?: number } | undefined) {
  if (value && bands.includes(value.band as Band)) return value.band as Band
  const score = value?.score
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  if (score >= 99.9) return 99.9
  return bands
    .slice(0, -1)
    .reduce((nearest, band) =>
      Math.abs(band - score) < Math.abs(nearest - score) ? band : nearest,
    )
}

/** One cohort per recorded game history. Retries do not add paths. */
export function readFlow(sql: Sql, start: string, end: string, mode: string) {
  const rows = sql.exec(
    `WITH selected AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY player, mode, round, feature, event, json_extract(details, '$.attempt')
        ORDER BY seq DESC
      ) AS latest
      FROM event_log WHERE day BETWEEN ? AND ? AND mode IS NOT NULL AND round IS NOT NULL
        AND (? = 'all' OR mode = ?) AND event IN ('puzzle_view','guess_submit','guess','finish','game_start')
    ), games AS (
      SELECT player, mode, round, feature,
        MAX(COALESCE(json_array_length(json_extract(details, '$.snapshot.game.guesses')),
          CASE WHEN event = 'guess' THEN json_extract(details, '$.attempt') END, 0)) AS guesses,
        MAX(COALESCE(json_extract(details, '$.snapshot.game.maxGuesses'), 6)) AS "limit",
        MAX(CASE WHEN event IN ('puzzle_view','guess_submit') AND
          json_array_length(json_extract(details, '$.snapshot.game.guesses')) = 0 THEN 1 ELSE 0 END) AS fromStart,
        MAX(CASE WHEN json_extract(details, '$.outcome') = 'won' OR json_extract(details, '$.snapshot.status') = 'won' THEN 1 ELSE 0 END) AS won,
        MAX(CASE WHEN json_extract(details, '$.outcome') = 'lost' OR json_extract(details, '$.snapshot.status') = 'lost' THEN 1 ELSE 0 END) AS lost,
        json_group_object(json_extract(details, '$.attempt'), json_object(
          'band', json_extract(details, '$.band'),
          'score', json_extract(details, '$.snapshot.game.guesses[#-1].score')
        )) FILTER (WHERE event = 'guess' AND latest = 1 AND json_extract(details, '$.attempt') IS NOT NULL) AS scores
      FROM selected GROUP BY player, mode, round, feature
    ) SELECT guesses, "limit", fromStart, scores,
      CASE WHEN won THEN 'won' WHEN lost THEN 'lost' ELSE 'open' END AS outcome, COUNT(*) AS count
    FROM games GROUP BY guesses, "limit", fromStart, outcome, scores`,
    start,
    end,
    mode,
    mode,
  )
  return [...rows].map((row): FlowGroup => {
    const { scores, ...group } = row as unknown as FlowGroup & {
      scores: string
    }
    const values = JSON.parse(scores) as Record<
      string,
      { band?: number; score?: number }
    >
    return {
      ...group,
      bands: Array.from({ length: group.guesses }, (_, i) =>
        scoreBand(values[i + 1]),
      ),
    }
  })
}

export function flowSteps(groups: FlowGroup[]) {
  const included = groups.filter((group) => group.fromStart)
  return {
    total: included.reduce((sum, group) => sum + group.count, 0),
    skipped: groups
      .filter((group) => !group.fromStart)
      .reduce((sum, group) => sum + group.count, 0),
    steps: Array.from(
      { length: Math.max(6, ...included.map((group) => group.limit)) + 1 },
      (_, guess) => {
        const count = (filter: (group: FlowGroup) => boolean) =>
          included.filter(filter).reduce((sum, group) => sum + group.count, 0)
        return {
          guess,
          reached: count((group) => group.guesses >= guess),
          next: count((group) => group.guesses > guess),
          won: count(
            (group) => group.guesses === guess && group.outcome === 'won',
          ),
          lost: count(
            (group) => group.guesses === guess && group.outcome === 'lost',
          ),
          open: count(
            (group) => group.guesses === guess && group.outcome === 'open',
          ),
        }
      },
    ),
  }
}

const colors = {
  step: '#7097ed',
  won: '#65b897',
  lost: '#e87f83',
  open: '#9296a4',
}
const bandColors: Record<string, string> = {
  0: '#ffffff',
  50: '#dd5b50',
  90: '#e98b32',
  95: '#e2cf37',
  99: '#4d9861',
  99.9: '#65b897',
  unknown: '#9296a4',
}
type Node = {
  id: string
  kind: keyof typeof colors
  guess: number
  band?: Band | null
  label: string
  count: number
  x: number
  y: number
  height: number
}
type Link = {
  source: Node
  target: Node
  count: number
  sourceY: number
  targetY: number
}

/** Counts determine ribbon thickness; layout never invents or drops games. */
export function layoutFlow(groups: FlowGroup[], byBand = false) {
  const summary = flowSteps(groups)
  const maximum = summary.steps.length - 1
  const width = byBand ? 1360 : 1120
  const scale = summary.total ? 140 / summary.total : 0
  const sinkX = width - 175,
    spacing = (sinkX - 85) / (maximum + 1)
  const nodes = new Map<string, Node>(),
    links = new Map<string, Link>()
  const node = (
    id: string,
    guess: number,
    kind: Node['kind'] = 'step',
    band?: Band | null,
  ) => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        kind,
        guess,
        band,
        count: 0,
        x: 0,
        y: 0,
        height: 0,
        label:
          kind === 'step'
            ? guess
              ? `Guess ${guess}${byBand ? ` · ${band === null ? 'Unknown' : `${band}%`}` : ''}`
              : 'Opened'
            : { won: 'Solved', lost: 'Out of attempts', open: 'Unfinished' }[
                kind
              ],
      })
    return nodes.get(id)!
  }
  for (const group of groups.filter((g) => g.fromStart)) {
    const path = [node('opened', 0)]
    for (let guess = 1; guess <= group.guesses; guess++) {
      const band = group.bands?.[guess - 1] ?? null
      path.push(
        node(
          `guess-${guess}${byBand ? `-${band ?? 'unknown'}` : ''}`,
          guess,
          'step',
          byBand ? band : undefined,
        ),
      )
    }
    path.push(node(group.outcome, maximum + 1, group.outcome))
    path.forEach((n) => {
      n.count += group.count
    })
    for (let i = 1; i < path.length; i++) {
      const key = `${path[i - 1].id}:${path[i].id}`
      if (!links.has(key))
        links.set(key, {
          source: path[i - 1],
          target: path[i],
          count: 0,
          sourceY: 0,
          targetY: 0,
        })
      links.get(key)!.count += group.count
    }
  }
  const order = [99.9, 99, 95, 90, 50, 0, null, undefined]
  for (let guess = 0; guess <= maximum; guess++) {
    const column = [...nodes.values()]
      .filter((n) => n.kind === 'step' && n.guess === guess)
      .sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band))
    const height =
      column.reduce((sum, n) => sum + n.count * scale, 0) +
      Math.max(0, column.length - 1) * 28
    let y = (byBand ? 240 : 190) - height / 2
    for (const n of column) {
      n.x = 28 + guess * spacing
      n.y = y
      n.height = n.count * scale
      y += n.height + 28
    }
  }
  const won = node('won', maximum + 1, 'won'),
    lost = node('lost', maximum + 1, 'lost'),
    open = node('open', maximum + 1, 'open')
  won.y = 20
  lost.y = byBand ? 440 : 305
  open.y = lost.y + lost.count * scale + 40
  for (const n of [won, lost, open]) {
    n.x = sinkX
    n.height = n.count * scale
  }
  for (const n of nodes.values()) {
    let outgoing = n.y,
      incoming = n.y
    for (const link of [...links.values()]
      .filter((l) => l.source === n)
      .sort((a, b) => a.target.y - b.target.y)) {
      link.sourceY = outgoing
      outgoing += link.count * scale
    }
    // Later guesses enter the top of Unfinished; opening without a guess is last.
    for (const link of [...links.values()]
      .filter((l) => l.target === n)
      .sort((a, b) =>
        n.kind === 'open'
          ? b.source.guess - a.source.guess || a.source.y - b.source.y
          : n.kind === 'step'
            ? a.source.y - b.source.y
            : a.source.guess - b.source.guess || a.source.y - b.source.y,
      )) {
      link.targetY = incoming
      incoming += link.count * scale
    }
  }
  return {
    ...summary,
    nodes: [...nodes.values()],
    links: [...links.values()],
    width,
    height: Math.max(byBand ? 560 : 440, open.y + open.height + 35),
    scale,
    spacing,
    won: won.count,
    lost: lost.count,
    open: open.count,
  }
}

const number = (n: number) => n.toLocaleString('en-US')
export function sankey(groups: FlowGroup[], byBand = false) {
  const flow = layoutFlow(groups, byBand)
  if (!flow.total)
    return '<p class="empty">Newly recorded games will appear here as players open a puzzle. Older aggregate counters cannot reconstruct these paths.</p>'
  const ribbon = (link: Link) => {
    const x1 = link.source.x + 12,
      x2 = link.target.x,
      y1 = link.sourceY,
      y2 = link.targetY,
      h = link.count * flow.scale,
      control = (x1 + x2) / 2
    const color =
      link.target.kind !== 'step'
        ? colors[link.target.kind]
        : byBand && link.target.band !== undefined
          ? link.target.band === 0
            ? colors.open
            : bandColors[link.target.band ?? 'unknown']
          : colors.step
    const title = `${number(link.count)} games: ${link.source.label} → ${link.target.label}`
    return `<path data-from="${link.source.id}" data-to="${link.target.id}" data-count="${link.count}" d="M${x1},${y1} C${control},${y1} ${control},${y2} ${x2},${y2} L${x2},${y2 + h} C${control},${y2 + h} ${control},${y1 + h} ${x1},${y1 + h} Z" fill="${color}" fill-opacity=".24" tabindex="0" aria-label="${e(title)}"><title>${e(title)}</title></path>`
  }
  const headers = flow.steps
    .map(
      (s) =>
        `<text x="${34 + s.guess * flow.spacing}" y="${byBand ? 55 : 94}" text-anchor="middle" class="node-label">${s.guess ? `Guess ${s.guess}` : 'Opened'}</text><text x="${34 + s.guess * flow.spacing}" y="${byBand ? 74 : 113}" text-anchor="middle">${number(s.reached)}</text>`,
    )
    .join('')
  const nodes = flow.nodes
    .map((n) => {
      const color =
        n.band === undefined ? colors[n.kind] : bandColors[n.band ?? 'unknown']
      const rect = `<rect data-node="${n.id}" x="${n.x}" y="${n.y}" width="12" height="${Math.max(1, n.height)}" rx="3" fill="${color}"${n.band === 0 ? ` stroke="${colors.open}"` : ''}><title>${e(`${n.label}: ${number(n.count)} games`)}</title></rect>`
      if (n.kind !== 'step')
        return `${rect}<text x="${n.x + 24}" y="${n.y + Math.max(4, n.height / 2) - 2}" class="node-label">${n.label}</text><text x="${n.x + 24}" y="${n.y + Math.max(4, n.height / 2) + 17}">${number(n.count)} · ${Math.round((n.count / flow.total) * 100)}%</text>`
      return (
        rect +
        (byBand && n.guess
          ? `<text class="band-label" x="${n.x - 7}" y="${n.y + n.height / 2 + 4}" text-anchor="end">${n.band === null ? 'Unknown' : `${n.band}%`} · ${number(n.count)}</text>`
          : '')
      )
    })
    .join('')
  const legend = (
    byBand
      ? [
          ...bands.map((b) => [`${b}%`, bandColors[b]]),
          ...(flow.nodes.some((n) => n.band === null)
            ? [['Unknown', colors.open]]
            : []),
        ]
      : [
          ['Continued', colors.step],
          ['Solved', colors.won],
          ['Out of attempts', colors.lost],
          ['Unfinished', colors.open],
        ]
  )
    .map(
      ([label, color]) =>
        `<span><i style="background:${color}${label === '0%' ? ';box-shadow:inset 0 0 0 1px var(--muted)' : ''}"></i>${label}</span>`,
    )
    .join('')
  const note = byBand
    ? 'Same games as the overview. Stored passages keep their labelled band; write-ins use the nearest band (99.9% only for wins). Missing scores appear as Unknown.'
    : `One path per browser and puzzle. Unfinished means no result has arrived yet. ${flow.skipped ? `${number(flow.skipped)} restored or partial histories are excluded because their opening state was not recorded.` : 'Only games with a recorded opening state are included.'}`
  return `<div class="legend">${legend}</div><p class="scroll-hint">Scroll sideways to follow every guess →</p><div class="chart-scroll flow${byBand ? ' band-flow' : ''}" tabindex="0" role="region" aria-label="${byBand ? 'Percentile' : 'Overview'} flow chart"><svg viewBox="0 0 ${flow.width} ${flow.height}" role="img" aria-label="Game progression${byBand ? ' by percentile' : ''}: ${flow.total} opened, ${flow.won} solved, ${flow.open} unfinished, ${flow.lost} out of attempts">${flow.links.map(ribbon).join('')}${headers}${nodes}</svg></div><p class="note">${note}</p>`
}
