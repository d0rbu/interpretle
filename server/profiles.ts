import type { Sql } from './analytics'
import type { ModelProfile } from '../src/lib/model-profile'

export type ProfileRun = {
  id: string
  at: string
  player: string
  mode: string
  round: string
  feature: string
  browser: string
  os: string
  backend: string
  status: string
  totalMs: number
  tokens: number
  run: number
}

/** Query the existing event history, without another telemetry store. */
export function readProfiles(
  sql: Sql,
  start: string,
  end: string,
  mode: string,
  runtime: string,
  selected?: string,
) {
  const base = `WITH passes AS (
    SELECT id, at, player, mode, round, feature, details, json_extract(details, '$.profile') AS profile
    FROM event_log WHERE event = 'model_profile' AND day BETWEEN ? AND ?
      AND (? = 'all' OR mode = ?) AND (? = 'all' OR json_extract(details, '$.profile.backend') = ?)
  )`
  const rows = <T>(query: string, ...args: string[]) =>
    [
      ...sql.exec(
        base + query,
        start,
        end,
        mode,
        mode,
        runtime,
        runtime,
        ...args,
      ),
    ] as unknown as T[]
  const summary = rows<{
    backend: string
    count: number
    completed: number
    failed: number
    cancelled: number
    p50Ms: number | null
    p95Ms: number | null
  }>(`, times AS (
    SELECT json_extract(profile, '$.backend') AS backend,
      json_extract(profile, '$.totalMs') AS ms,
      ROW_NUMBER() OVER (PARTITION BY json_extract(profile, '$.backend') ORDER BY json_extract(profile, '$.totalMs')) AS n,
      COUNT(*) OVER (PARTITION BY json_extract(profile, '$.backend')) AS total
    FROM passes WHERE json_extract(profile, '$.status') = 'ok'
  ) SELECT json_extract(profile, '$.backend') AS backend, COUNT(*) AS count,
    SUM(json_extract(profile, '$.status') = 'ok') AS completed,
    SUM(json_extract(profile, '$.status') = 'error') AS failed,
    SUM(json_extract(profile, '$.status') = 'cancelled') AS cancelled,
    (SELECT MIN(ms) FROM times t WHERE t.backend = json_extract(p.profile, '$.backend') AND n >= total * 0.5) AS p50Ms,
    (SELECT MIN(ms) FROM times t WHERE t.backend = json_extract(p.profile, '$.backend') AND n >= total * 0.95) AS p95Ms
    FROM passes p GROUP BY backend ORDER BY backend`)
  const phases = rows<{
    kind: string
    ms: number
    count: number
  }>(`, totals AS (
    SELECT p.id, json_extract(s.value, '$.kind') AS kind, SUM(json_extract(s.value, '$.ms')) AS ms
    FROM passes p, json_each(p.profile, '$.steps') s WHERE json_extract(p.profile, '$.status') = 'ok'
    GROUP BY p.id, kind
    UNION ALL
    SELECT p.id, 'weight_read', SUM(COALESCE(json_extract(s.value, '$.readMs'), 0))
    FROM passes p, json_each(p.profile, '$.steps') s WHERE json_extract(p.profile, '$.status') = 'ok' AND json_extract(s.value, '$.kind') = 'weights'
    GROUP BY p.id
    UNION ALL
    SELECT p.id, 'weight_decode', SUM(COALESCE(json_extract(s.value, '$.decodeMs'), 0))
    FROM passes p, json_each(p.profile, '$.steps') s WHERE json_extract(p.profile, '$.status') = 'ok' AND json_extract(s.value, '$.kind') = 'weights'
    GROUP BY p.id
  ) SELECT kind, AVG(ms) AS ms, COUNT(*) AS count FROM totals GROUP BY kind ORDER BY ms DESC`)
  const operations = rows<{ name: string; ms: number; count: number }>(`
    SELECT json_extract(s.value, '$.name') AS name, AVG(json_extract(s.value, '$.ms')) AS ms, COUNT(*) AS count
    FROM passes p, json_each(p.profile, '$.steps') s
    WHERE json_extract(p.profile, '$.status') = 'ok' AND json_extract(s.value, '$.kind') = 'compute'
    GROUP BY name ORDER BY ms DESC`)
  const layers = rows<{
    layer: number
    ms: number
    count: number
  }>(`, totals AS (
    SELECT p.id, json_extract(s.value, '$.layer') AS layer, SUM(json_extract(s.value, '$.ms')) AS ms
    FROM passes p, json_each(p.profile, '$.steps') s
    WHERE json_extract(p.profile, '$.status') = 'ok' AND json_extract(s.value, '$.kind') = 'compute'
      AND json_extract(s.value, '$.layer') IS NOT NULL
    GROUP BY p.id, layer
  ) SELECT layer, AVG(ms) AS ms, COUNT(*) AS count FROM totals GROUP BY layer ORDER BY layer`)
  const recent = rows<ProfileRun>(`
    SELECT id, at, player, mode, round, feature,
      json_extract(details, '$.browser') AS browser, json_extract(details, '$.os') AS os,
      json_extract(profile, '$.backend') AS backend, json_extract(profile, '$.status') AS status,
      json_extract(profile, '$.totalMs') AS totalMs, json_extract(profile, '$.tokens') AS tokens,
      json_extract(profile, '$.run') AS run
    FROM passes ORDER BY at DESC, id DESC LIMIT 20`)
  const detail = selected ?? recent[0]?.id
  const [entry] = detail
    ? rows<{ profile: string }>(
        ' SELECT profile FROM passes WHERE id = ?',
        detail,
      )
    : []
  return {
    runtime,
    summary,
    phases,
    operations,
    layers,
    recent,
    expanded: Boolean(selected),
    selected: entry
      ? { id: detail!, profile: JSON.parse(entry.profile) as ModelProfile }
      : null,
  }
}
