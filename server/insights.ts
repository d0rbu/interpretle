import type { Sql } from './analytics'
import type { RuntimeReport } from '../src/lib/diagnostics'
import { readProfiles } from './profiles'
import { readFlow } from './flow'

type Counts = { label: string; count: number }
export type ErrorSample = {
  id: string
  at: string
  player: string
  details: {
    browser: string
    os: string
    device: string
    backend: string
    phase: string
    code: string
    mode?: string
    round?: string
    feature?: string
    cores?: number
    memoryGb?: number
    clientAt?: string
    report?: RuntimeReport
  }
}
type Issue = {
  issue: string
  count: number
  players: number
  firstAt: string
  lastAt: string
  samples: ErrorSample[]
}
type FlowSelection = { day: string; daily: boolean; practice: boolean }

function readInsights(
  sql: Sql,
  end: string,
  days: number,
  mode: string,
  runtime: string,
  flowSelection: FlowSelection,
  profile?: string,
) {
  const start = new Date(Date.parse(end + 'T12:00:00Z') - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10)
  const rows = <T>(query: string, ...values: (string | number)[]) =>
    [...sql.exec(query, ...values)] as unknown as T[]
  const counts = rows<{
    day: string
    games: number
    wins: number
    losses: number
    errors: number
    guesses: number
    writeins: number
    shares: number
  }>(
    `
    WITH selected AS (
      SELECT *, (? = 'all' OR json_extract(dimensions, '$.mode') = ?) AS included
      FROM counters WHERE day BETWEEN ? AND ?
    ) SELECT day,
      SUM(CASE WHEN event = 'game_start' AND included THEN count ELSE 0 END) AS games,
      SUM(CASE WHEN event = 'finish' AND included AND json_extract(dimensions, '$.outcome') = 'won' THEN count ELSE 0 END) AS wins,
      SUM(CASE WHEN event = 'finish' AND included AND json_extract(dimensions, '$.outcome') = 'lost' THEN count ELSE 0 END) AS losses,
      SUM(CASE WHEN event IN ('model_error','client_error') THEN count ELSE 0 END) AS errors,
      SUM(CASE WHEN event = 'guess' AND included THEN count ELSE 0 END) AS guesses,
      SUM(CASE WHEN event = 'guess' AND included AND json_extract(dimensions, '$.passage') IS NULL THEN count ELSE 0 END) AS writeins,
      SUM(CASE WHEN event = 'share' AND included THEN count ELSE 0 END) AS shares
    FROM selected GROUP BY day`,
    mode,
    mode,
    start,
    end,
  )
  const audience = rows<{
    day: string
    browsers: number
    returning: number
    visits: number
  }>(
    `
    SELECT day, COUNT(*) AS browsers, SUM(p.first_day < a.day) AS "returning", SUM(visits) AS visits
    FROM activity a JOIN players p ON p.id = a.player WHERE day BETWEEN ? AND ? GROUP BY day`,
    start,
    end,
  )
  const series = Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.parse(start + 'T12:00:00Z') + i * 86400000)
      .toISOString()
      .slice(0, 10)
    return {
      day,
      browsers: 0,
      returning: 0,
      visits: 0,
      games: 0,
      wins: 0,
      losses: 0,
      errors: 0,
      guesses: 0,
      writeins: 0,
      shares: 0,
      ...counts.find((row) => row.day === day),
      ...audience.find((row) => row.day === day),
    }
  })
  const [people] = rows<{ browsers: number; returning: number }>(
    `
    SELECT COUNT(DISTINCT player) AS browsers,
      COUNT(DISTINCT CASE WHEN p.first_day < a.day THEN player END) AS "returning"
    FROM activity a JOIN players p ON p.id = a.player WHERE day BETWEEN ? AND ?`,
    start,
    end,
  )
  const counterBreakdown = (event: string, field: string, onlyGame = true) =>
    rows<Counts>(
      `
    SELECT COALESCE(CAST(json_extract(dimensions, '$.${field}') AS TEXT), 'Unknown') AS label, SUM(count) AS count
    FROM counters WHERE day BETWEEN ? AND ? AND event = ?
      ${onlyGame ? "AND (? = 'all' OR json_extract(dimensions, '$.mode') = ?)" : ''}
    GROUP BY label ORDER BY label`,
      start,
      end,
      event,
      ...(onlyGame ? [mode, mode] : []),
    )
  const themes = rows<Counts>(
    `
    SELECT COALESCE(json_extract(dimensions, '$.themePreference') || ' / ' || json_extract(dimensions, '$.theme'), 'Unknown') AS label,
      SUM(count) AS count FROM counters WHERE day BETWEEN ? AND ? AND event = 'theme' GROUP BY label ORDER BY count DESC`,
    start,
    end,
  )
  const devices = rows<Counts>(
    `
    SELECT COALESCE(json_extract(details, '$.device'), 'unknown') AS label, COUNT(*) AS count
    FROM event_log WHERE day BETWEEN ? AND ? AND event = 'visit' GROUP BY label ORDER BY count DESC`,
    start,
    end,
  )
  const practice = rows<Counts>(
    `
    WITH totals AS (SELECT player, SUM(practice) AS n FROM activity WHERE day BETWEEN ? AND ? GROUP BY player)
    SELECT CASE WHEN n < 3 THEN CAST(n AS TEXT) WHEN n < 6 THEN '3–5' WHEN n < 11 THEN '6–10' ELSE '11+' END AS label,
      COUNT(*) AS count FROM totals GROUP BY label ORDER BY MIN(n)`,
    start,
    end,
  )
  const flowMode = flowSelection.daily
    ? flowSelection.practice
      ? 'all'
      : 'daily'
    : 'practice'
  const flow =
    flowSelection.daily || flowSelection.practice
      ? readFlow(sql, flowSelection.day, flowSelection.day, flowMode)
      : []
  const issues = rows<Omit<Issue, 'samples'> & { samples: string }>(
    `
    WITH errors AS (
      SELECT *, COALESCE(json_extract(details, '$.fingerprint'),
        'legacy:' || COALESCE(json_extract(details, '$.code'), 'unknown') || ':' ||
        COALESCE(json_extract(details, '$.phase'), 'unknown') || ':' ||
        COALESCE(json_extract(details, '$.backend'), 'unknown')) AS issue
      FROM model_errors WHERE day BETWEEN ? AND ?
    ), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY issue ORDER BY at DESC, id DESC) AS n FROM errors)
    SELECT issue, COUNT(*) AS count, COUNT(DISTINCT player) AS players, MIN(at) AS firstAt, MAX(at) AS lastAt,
      json_group_array(json_object('id', id, 'at', at, 'player', player, 'details', json(details))) FILTER (WHERE n <= 3) AS samples
    FROM ranked GROUP BY issue ORDER BY count DESC, lastAt DESC LIMIT 50`,
    start,
    end,
  ).map((row): Issue => ({ ...row, samples: JSON.parse(row.samples) }))
  const [coverage] = rows<{
    historySince: string | null
    errorRecords: number
    exceptions: number
  }>(
    `
    SELECT (SELECT MIN(at) FROM event_log) AS historySince,
      COUNT(*) AS errorRecords, COALESCE(SUM(json_extract(details, '$.report') IS NOT NULL), 0) AS exceptions
    FROM model_errors WHERE day BETWEEN ? AND ?`,
    start,
    end,
  )
  return {
    start,
    end,
    days,
    mode,
    series,
    people,
    flow,
    flowSelection,
    issues,
    coverage,
    attempts: rows<Counts>(
      `
      SELECT CAST(json_extract(dimensions, '$.attempt') AS TEXT) AS label, SUM(count) AS count
      FROM counters WHERE day BETWEEN ? AND ? AND event = 'finish' AND json_extract(dimensions, '$.outcome') = 'won'
        AND (? = 'all' OR json_extract(dimensions, '$.mode') = ?) GROUP BY label ORDER BY CAST(label AS INTEGER)`,
      start,
      end,
      mode,
      mode,
    ),
    outcomes: counterBreakdown('finish', 'outcome'),
    slots: rows<Counts>(
      `
      SELECT CASE WHEN json_extract(dimensions, '$.passage') IS NULL THEN 'Write-in'
        ELSE 'Option ' || COALESCE(CAST(json_extract(dimensions, '$.slot') AS TEXT), '?') END AS label, SUM(count) AS count
      FROM counters WHERE day BETWEEN ? AND ? AND event = 'guess' AND (? = 'all' OR json_extract(dimensions, '$.mode') = ?)
      GROUP BY label ORDER BY label`,
      start,
      end,
      mode,
      mode,
    ),
    themes,
    devices,
    practice,
    profiles: readProfiles(sql, start, end, mode, runtime, profile),
  }
}

export type Insights = ReturnType<typeof readInsights>

export function dashboardData(sql: Sql, params: URLSearchParams, end: string) {
  const days = Number(params.get('days') ?? 14)
  const mode = params.get('game') ?? 'all'
  const runtime = params.get('runtime') ?? 'all'
  const profile = params.get('pass') ?? undefined
  const flowDay = params.get('flowDay') ?? end
  const flowSelection = {
    day: flowDay,
    daily: params.has('flowDay')
      ? params.get('flowDaily') === '1'
      : mode !== 'practice',
    practice: params.has('flowDay')
      ? params.get('flowPractice') === '1'
      : mode !== 'daily',
  }
  const validDay = (day: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day + 'T12:00:00Z')) &&
    new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) === day
  if (
    ![1, 7, 14, 30, 90].includes(days) ||
    !['all', 'daily', 'practice'].includes(mode) ||
    !['all', 'gpu', 'cpu'].includes(runtime) ||
    (profile !== undefined && !/^[a-f0-9]{64}$/.test(profile)) ||
    !validDay(end) ||
    !validDay(flowDay) ||
    ['flowDaily', 'flowPractice'].some(
      (key) => params.has(key) && params.get(key) !== '1',
    )
  )
    return Response.json({ error: 'Invalid dashboard range.' }, { status: 400 })
  return Response.json(
    readInsights(sql, end, days, mode, runtime, flowSelection, profile),
    {
      headers: { 'Cache-Control': 'private, no-store, no-transform' },
    },
  )
}
