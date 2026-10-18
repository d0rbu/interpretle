import catalog from '../public/puzzles/index.json'
import { puzzleDay } from '../src/lib/day'
import { EVENTS, PROBLEMS, THEMES } from '../src/lib/analytics'
import {
  MODEL_BACKENDS,
  MODEL_ERROR_CODES,
  MODEL_PHASES,
} from '../src/lib/model-error'
import { deviceInfo } from './device'
import { validSnapshot } from './replay'
import { validReport, errorFingerprint } from './diagnostics'
import { dashboardData } from './insights'

export interface Sql {
  exec(
    query: string,
    ...values: (string | number | null)[]
  ): Iterable<Record<string, string | number>>
}
const json = (body: object, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, no-transform' },
  })
const targets = new Set([...Object.values(catalog.daily), ...catalog.practice])
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fields = [
  'theme',
  'themePreference',
  'mode',
  'round',
  'feature',
  'passage',
  'slot',
  'band',
  'attempt',
  'outcome',
  'problem',
] as const
const diagnosticFields = [
  'code',
  'phase',
  'backend',
  'httpStatus',
  'layer',
  'cores',
  'memoryGb',
  'touchPoints',
  'report',
] as const
const recordFields = [
  'at',
  'visit',
  'sequence',
  'submission',
  'text',
  'expanded',
  'snapshot',
] as const

function normalizeIp(value: string | null) {
  if (!value || !/^[\da-f:.]{2,45}$/i.test(value)) return undefined
  const ipv6 = value.includes(':')
  if (!ipv6 && !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return undefined
  try {
    const host = new URL(`http://${ipv6 ? `[${value}]` : value}/`).hostname
    return ipv6 ? host.slice(1, -1) : host === value ? host : undefined
  } catch {
    return undefined
  }
}

// Browser/IP counters and append-only game history. Reads stay behind /admin auth.
export class GameAnalytics {
  sql: Sql
  constructor(state: { storage: { sql: Sql } }) {
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, first_day TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS counters (
        day TEXT, event TEXT, dimensions TEXT, count INTEGER NOT NULL,
        PRIMARY KEY (day, event, dimensions)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS activity (
        day TEXT, player TEXT, visits INTEGER NOT NULL, practice INTEGER NOT NULL,
        PRIMARY KEY (day, player)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS browser_counters (
        player TEXT, day TEXT, event TEXT, dimensions TEXT, count INTEGER NOT NULL,
        PRIMARY KEY (player, day, event, dimensions)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS browser_counters_day ON browser_counters (day);
      CREATE TABLE IF NOT EXISTS ip_counters (
        ip TEXT, day TEXT, player TEXT, event TEXT, dimensions TEXT, count INTEGER NOT NULL,
        PRIMARY KEY (ip, day, player, event, dimensions)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ip_counters_day ON ip_counters (day);
      CREATE INDEX IF NOT EXISTS ip_counters_player ON ip_counters (player);
      CREATE TABLE IF NOT EXISTS model_errors (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, at TEXT NOT NULL,
        player TEXT NOT NULL, ip TEXT, details TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS model_errors_day ON model_errors (day, at);
      CREATE INDEX IF NOT EXISTS model_errors_player ON model_errors (player, at);
      CREATE INDEX IF NOT EXISTS model_errors_ip ON model_errors (ip, at);
      CREATE TABLE IF NOT EXISTS event_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        day TEXT NOT NULL, at TEXT NOT NULL, player TEXT NOT NULL, ip TEXT,
        event TEXT NOT NULL, mode TEXT, round TEXT, feature TEXT, details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_log_day ON event_log (day, seq);
      CREATE INDEX IF NOT EXISTS event_log_ip ON event_log (ip, seq);
      CREATE INDEX IF NOT EXISTS event_log_game ON event_log (player, mode, round, feature, seq);
    `)
  }

  async fetch(request: Request) {
    const now = new Date()
    const day = puzzleDay(now)
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams
      const selected = params.get('day') || day
      const selectedBrowser = params.get('browser') || undefined
      const selectedIp = normalizeIp(params.get('ip'))
      const selectedRound = params.get('round')
      const selectedMode = params.get('mode')
      const selectedFeature = params.get('feature')
      const after = Number(params.get('after') ?? 0)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || selected > day)
        return json({ error: 'Invalid day.' }, 400)
      if (params.get('view') === 'dashboard')
        return dashboardData(this.sql, params, selected)
      if (selectedBrowser && !uuid.test(selectedBrowser))
        return json({ error: 'Invalid browser ID.' }, 400)
      if (params.get('ip') && !selectedIp)
        return json({ error: 'Invalid IP address.' }, 400)
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        (selectedRound !== null &&
          (!selectedBrowser ||
            !['daily', 'practice'].includes(selectedMode ?? '') ||
            !targets.has(selectedFeature ?? '') ||
            !(selectedMode === 'daily'
              ? /^\d{4}-\d{2}-\d{2}$/.test(selectedRound)
              : uuid.test(selectedRound))))
      )
        return json({ error: 'Invalid game selection.' }, 400)
      const historyKey = selectedBrowser ? 'player' : selectedIp ? 'ip' : 'day'
      const historyValues: (string | number)[] = [
        selectedBrowser ?? selectedIp ?? selected,
      ]
      let historyWhere = `${historyKey} = ?`
      if (selectedRound !== null) {
        historyWhere += ' AND mode = ? AND round = ? AND feature = ?'
        historyValues.push(selectedMode!, selectedRound, selectedFeature!)
      }
      const events =
        selectedRound !== null || params.get('format') === 'json'
          ? [
              ...this.sql.exec(
                `SELECT seq, id, at AS receivedAt, player, ip, event, details FROM event_log
          WHERE ${historyWhere} AND seq > ? ORDER BY seq LIMIT 101`,
                ...historyValues,
                after,
              ),
            ].map(({ details, ...row }) => ({
              ...row,
              ...JSON.parse(String(details)),
            }))
          : []
      const nextCursor = events.length > 100 ? events[99].seq : null
      if (events.length > 100) events.pop()
      if (params.get('format') === 'json')
        return json({
          version: 1,
          day: selected,
          browser: selectedBrowser,
          round: selectedRound,
          events,
          nextCursor,
        })
      const games = [
        ...this.sql.exec(
          `SELECT player, mode, round, feature,
        MIN(at) AS firstAt, MAX(at) AS lastAt,
        COALESCE(MAX(json_array_length(json_extract(details, '$.snapshot.game.guesses'))),
          MAX(CASE WHEN event = 'guess' THEN json_extract(details, '$.attempt') END), 0) AS guesses,
        MAX(CASE WHEN event = 'finish' THEN json_extract(details, '$.outcome')
          WHEN json_extract(details, '$.snapshot.status') IN ('won', 'lost') THEN json_extract(details, '$.snapshot.status') END) AS outcome
        FROM event_log WHERE ${historyWhere} AND mode IS NOT NULL AND round IS NOT NULL
        GROUP BY player, mode, round, feature ORDER BY lastAt DESC LIMIT 200`,
          ...historyValues,
        ),
      ]
      const counts = [
        ...this.sql.exec(
          'SELECT event, dimensions, count FROM counters WHERE day = ? ORDER BY event, dimensions',
          selected,
        ),
      ].map((row) => ({
        event: row.event,
        ...JSON.parse(String(row.dimensions)),
        count: row.count,
      }))
      const [players] = this.sql.exec(
        `SELECT COUNT(*) AS players,
        COALESCE(SUM(p.first_day < a.day), 0) AS "returning",
        COALESCE(SUM(a.visits), 0) AS visits, COALESCE(SUM(a.practice), 0) AS practiceRounds
        FROM activity a JOIN players p ON a.player = p.id WHERE a.day = ?`,
        selected,
      )
      const practice = [
        ...this.sql.exec(
          'SELECT practice AS rounds, COUNT(*) AS players FROM activity WHERE day = ? GROUP BY practice ORDER BY practice',
          selected,
        ),
      ]
      const metrics = `
        COALESCE(SUM(CASE WHEN event = 'guess' THEN count ELSE 0 END), 0) AS guesses,
        COALESCE(SUM(CASE WHEN event = 'guess' AND json_extract(dimensions, '$.passage') IS NULL THEN count ELSE 0 END), 0) AS writeins,
        COALESCE(SUM(CASE WHEN event = 'finish' AND json_extract(dimensions, '$.outcome') = 'won' THEN count ELSE 0 END), 0) AS wins,
        COALESCE(SUM(CASE WHEN event = 'finish' AND json_extract(dimensions, '$.outcome') = 'lost' THEN count ELSE 0 END), 0) AS losses,
        GROUP_CONCAT(DISTINCT json_extract(dimensions, '$.themePreference') || ' / ' || json_extract(dimensions, '$.theme')) AS themes`
      const ipMetrics = `
        COALESCE(SUM(CASE WHEN event = 'visit' THEN count ELSE 0 END), 0) AS visits,
        COALESCE(SUM(CASE WHEN event = 'game_start' AND json_extract(dimensions, '$.mode') = 'practice' THEN count ELSE 0 END), 0) AS practiceRounds,
        ${metrics}`
      const browsers = [
        ...this.sql.exec(
          `WITH usage AS (SELECT player, ${metrics} FROM browser_counters WHERE day = ? GROUP BY player)
        SELECT a.player AS id, a.visits, a.practice AS practiceRounds,
          COALESCE(u.guesses, 0) AS guesses, COALESCE(u.writeins, 0) AS writeins,
          COALESCE(u.wins, 0) AS wins, COALESCE(u.losses, 0) AS losses, COALESCE(u.themes, '') AS themes
        FROM activity a LEFT JOIN usage u ON u.player = a.player
        WHERE a.day = ? ORDER BY a.visits DESC, guesses DESC, a.player LIMIT 200`,
          selected,
          selected,
        ),
      ]
      const [{ ipCount }] = this.sql.exec(
        'SELECT COUNT(DISTINCT ip) AS ipCount FROM ip_counters WHERE day = ?',
        selected,
      )
      const ips = [
        ...this.sql.exec(
          `SELECT ip AS id, COUNT(DISTINCT player) AS browserCount, ${ipMetrics}
          FROM ip_counters WHERE day = ? GROUP BY ip
          ORDER BY visits DESC, guesses DESC, ip LIMIT 200`,
          selected,
        ),
      ]
      let browser
      if (selectedBrowser) {
        const [person] = this.sql.exec(
          'SELECT first_day AS firstDay FROM players WHERE id = ?',
          selectedBrowser,
        )
        if (!person) return json({ error: 'Browser not found.' }, 404)
        const [activity] = this.sql.exec(
          'SELECT SUM(visits) AS visits, SUM(practice) AS practiceRounds FROM activity WHERE player = ?',
          selectedBrowser,
        )
        const [totals] = this.sql.exec(
          `SELECT ${metrics} FROM browser_counters WHERE player = ?`,
          selectedBrowser,
        )
        const history = [
          ...this.sql.exec(
            "SELECT day, dimensions, count FROM browser_counters WHERE player = ? AND event = 'finish' ORDER BY day DESC, dimensions LIMIT 200",
            selectedBrowser,
          ),
        ].map(({ day, dimensions, count }) => ({
          day,
          ...JSON.parse(String(dimensions)),
          count,
        }))
        const addresses = [
          ...this.sql.exec(
            `SELECT ip AS id, MIN(day) AS firstDay, MAX(day) AS lastDay
            FROM ip_counters WHERE player = ? GROUP BY ip ORDER BY lastDay DESC, ip LIMIT 200`,
            selectedBrowser,
          ),
        ]
        browser = {
          id: selectedBrowser,
          ...person,
          ...activity,
          ...totals,
          history,
          addresses,
        }
      }
      let ip
      if (selectedIp) {
        const [totals] = this.sql.exec(
          `SELECT MIN(day) AS firstDay, MAX(day) AS lastDay,
          COUNT(DISTINCT player) AS browserCount, ${ipMetrics} FROM ip_counters WHERE ip = ?`,
          selectedIp,
        )
        if (!totals.firstDay)
          return json({ error: 'IP address not found.' }, 404)
        const browsers = [
          ...this.sql.exec(
            `SELECT player AS id, ${ipMetrics} FROM ip_counters WHERE ip = ?
            GROUP BY player ORDER BY visits DESC, guesses DESC, player LIMIT 200`,
            selectedIp,
          ),
        ]
        const history = [
          ...this.sql.exec(
            `SELECT day, player, dimensions, count FROM ip_counters WHERE ip = ? AND event = 'finish'
            ORDER BY day DESC, player, dimensions LIMIT 200`,
            selectedIp,
          ),
        ].map(({ day, player, dimensions, count }) => ({
          day,
          player,
          ...JSON.parse(String(dimensions)),
          count,
        }))
        const counters = [
          ...this.sql.exec(
            `SELECT event, json_remove(dimensions, '$.round') AS dimensions, SUM(count) AS count
            FROM ip_counters WHERE ip = ? AND day = ?
            GROUP BY event, json_remove(dimensions, '$.round') ORDER BY event, dimensions`,
            selectedIp,
            selected,
          ),
        ].map(({ event, dimensions, count }) => ({
          event,
          ...JSON.parse(String(dimensions)),
          count,
        }))
        ip = { id: selectedIp, ...totals, browsers, history, counters }
      }
      const errorKey = selectedBrowser ? 'player' : selectedIp ? 'ip' : 'day'
      const errorValue = selectedBrowser ?? selectedIp ?? selected
      const modelErrors = [
        ...this.sql.exec(
          `SELECT at, player, ip, details FROM model_errors WHERE ${errorKey} = ?
        ORDER BY at DESC, id DESC LIMIT 200`,
          errorValue,
        ),
      ].map(({ at, player, ip, details }) => ({
        at,
        player,
        ip,
        ...JSON.parse(String(details)),
      }))
      const modelErrorGroups = [
        ...this.sql.exec(
          `SELECT json_extract(details, '$.problem') AS problem,
          json_extract(details, '$.code') AS code, json_extract(details, '$.phase') AS phase,
          json_extract(details, '$.backend') AS backend, json_extract(details, '$.device') AS device,
          json_extract(details, '$.browser') AS browser, json_extract(details, '$.os') AS os, COUNT(*) AS count
        FROM model_errors WHERE ${errorKey} = ? GROUP BY problem, code, phase, backend, device, browser, os
        ORDER BY count DESC, code LIMIT 200`,
          errorValue,
        ),
      ]
      return json({
        day: selected,
        ...players,
        practice,
        counters: counts,
        browsers,
        browser,
        ipCount,
        ips,
        ip,
        modelErrors,
        modelErrorGroups,
        games,
        events,
        nextCursor,
        selectedGame:
          selectedRound === null
            ? null
            : {
                mode: selectedMode,
                round: selectedRound,
                feature: selectedFeature,
              },
      })
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json'))
      return json({ error: 'Expected JSON.' }, 415)
    const text = await request.text()
    if (text.length > 262144) return json({ error: 'Event too large.' }, 413)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return json({ error: 'Invalid JSON.' }, text.length > 1024 ? 413 : 400)
    }
    if (text.length > (data?.report ? 32768 : 1024) && !data?.snapshot)
      return json({ error: 'Event too large.' }, 413)
    if (
      !data ||
      typeof data.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.id) ||
      typeof data.player !== 'string' ||
      !uuid.test(data.player) ||
      !EVENTS.includes(data.event) ||
      Object.keys(data).some(
        (key) =>
          ![
            'id',
            'player',
            'event',
            ...fields,
            ...diagnosticFields,
            ...recordFields,
          ].includes(key),
      ) ||
      (data.at !== undefined &&
        (typeof data.at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.at) ||
          !Number.isFinite(Date.parse(data.at)))) ||
      (data.visit !== undefined &&
        (typeof data.visit !== 'string' || !uuid.test(data.visit))) ||
      (data.sequence !== undefined &&
        (!Number.isSafeInteger(data.sequence) || data.sequence < 1)) ||
      (data.submission !== undefined &&
        (typeof data.submission !== 'string' || !uuid.test(data.submission))) ||
      (data.text !== undefined &&
        (data.event !== 'guess_submit' ||
          data.passage !== undefined ||
          typeof data.text !== 'string' ||
          !data.text.trim() ||
          Array.from(data.text).length > 280)) ||
      (data.expanded !== undefined &&
        (data.event !== 'context' || typeof data.expanded !== 'boolean')) ||
      (data.snapshot !== undefined &&
        (!['puzzle_view', 'guess_submit', 'guess'].includes(data.event) ||
          !data.mode ||
          !data.round ||
          !data.feature ||
          !validSnapshot(data.snapshot, {
            mode: data.mode,
            round: data.round,
            feature: data.feature,
          }))) ||
      (data.event === 'guess_submit' &&
        (!data.snapshot ||
          !data.submission ||
          !data.attempt ||
          (data.text === undefined && data.passage === undefined))) ||
      (!['model_error', 'client_error'].includes(data.event) &&
        diagnosticFields.some((key) => data[key] !== undefined)) ||
      (data.report !== undefined && !validReport(data.report)) ||
      (data.code !== undefined && !MODEL_ERROR_CODES.includes(data.code)) ||
      (data.phase !== undefined && !MODEL_PHASES.includes(data.phase)) ||
      (data.backend !== undefined && !MODEL_BACKENDS.includes(data.backend)) ||
      (data.httpStatus !== undefined &&
        (!Number.isInteger(data.httpStatus) ||
          data.httpStatus < 100 ||
          data.httpStatus > 599)) ||
      (data.layer !== undefined &&
        (!Number.isInteger(data.layer) ||
          data.layer < 0 ||
          data.layer > 255)) ||
      (data.cores !== undefined &&
        (!Number.isInteger(data.cores) ||
          data.cores < 1 ||
          data.cores > 1024)) ||
      (data.memoryGb !== undefined &&
        (typeof data.memoryGb !== 'number' ||
          !Number.isFinite(data.memoryGb) ||
          data.memoryGb <= 0 ||
          data.memoryGb > 1024)) ||
      (data.touchPoints !== undefined &&
        (!Number.isInteger(data.touchPoints) ||
          data.touchPoints < 0 ||
          data.touchPoints > 100)) ||
      (data.mode !== undefined && !['daily', 'practice'].includes(data.mode)) ||
      (data.round !== undefined &&
        (typeof data.round !== 'string' ||
          (data.mode === 'daily'
            ? !/^\d{4}-\d{2}-\d{2}$/.test(data.round)
            : data.mode === 'practice'
              ? !uuid.test(data.round)
              : true))) ||
      (data.feature !== undefined && !targets.has(data.feature)) ||
      (data.passage !== undefined &&
        (typeof data.passage !== 'string' ||
          data.passage.length > 100 ||
          !/^(chat|prose|code|reference):[\w-]+:\d+-\d+$/.test(
            data.passage,
          ))) ||
      (data.slot !== undefined &&
        (!Number.isInteger(data.slot) || data.slot < 1 || data.slot > 5)) ||
      (data.band !== undefined &&
        ![0, 50, 90, 95, 99, 99.9].includes(data.band)) ||
      (data.attempt !== undefined &&
        (!Number.isInteger(data.attempt) ||
          data.attempt < 1 ||
          data.attempt > 8)) ||
      (data.outcome !== undefined && !['won', 'lost'].includes(data.outcome)) ||
      (data.problem !== undefined && !PROBLEMS.includes(data.problem)) ||
      (data.theme !== undefined && !['light', 'dark'].includes(data.theme)) ||
      (data.themePreference !== undefined &&
        !THEMES.includes(data.themePreference)) ||
      (data.event === 'theme' && (!data.theme || !data.themePreference)) ||
      (data.theme &&
        data.themePreference &&
        data.themePreference !== 'system' &&
        data.theme !== data.themePreference)
    )
      return json({ error: 'Invalid event.' }, 400)
    const fingerprint = data.report
      ? await errorFingerprint(
          data.report,
          data.code,
          data.backend,
          data.httpStatus,
        )
      : undefined
    if (
      ![
        ...this.sql.exec(
          'INSERT OR IGNORE INTO seen (id) VALUES (?) RETURNING id',
          data.id,
        ),
      ].length
    )
      return new Response(null, { status: 204 })
    const dimensions = Object.fromEntries(
      fields
        .filter((key) => key !== 'round' && data[key] !== undefined)
        .map((key) => [key, data[key]]),
    )
    // These synchronous writes share the Durable Object's implicit transaction.
    const roundDimensions = JSON.stringify({
      ...dimensions,
      ...(data.round ? { round: data.round } : {}),
    })
    this.sql.exec(
      'INSERT OR IGNORE INTO players (id, first_day) VALUES (?, ?)',
      data.player,
      day,
    )
    this.sql.exec(
      `INSERT INTO counters (day, event, dimensions, count) VALUES (?, ?, ?, 1)
      ON CONFLICT (day, event, dimensions) DO UPDATE SET count = count + 1`,
      day,
      data.event,
      JSON.stringify(dimensions),
    )
    this.sql.exec(
      `INSERT INTO activity (day, player, visits, practice) VALUES (?, ?, ?, ?)
      ON CONFLICT (day, player) DO UPDATE SET visits = visits + excluded.visits, practice = practice + excluded.practice`,
      day,
      data.player,
      data.event === 'visit' ? 1 : 0,
      data.event === 'game_start' && data.mode === 'practice' ? 1 : 0,
    )
    this.sql.exec(
      `INSERT INTO browser_counters (player, day, event, dimensions, count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (player, day, event, dimensions) DO UPDATE SET count = count + 1`,
      data.player,
      day,
      data.event,
      roundDimensions,
    )
    // Cloudflare supplies this header at the edge; never take an IP from the
    // event body or X-Forwarded-For. The Durable Object has no public endpoint.
    const ip = normalizeIp(request.headers.get('CF-Connecting-IP'))
    const details = {
      ...(fingerprint ? { fingerprint } : {}),
      ...Object.fromEntries(
        [...fields, ...diagnosticFields, ...recordFields]
          .filter((key) => data[key] !== undefined)
          .map((key) => [key, data[key]]),
      ),
      ...deviceInfo(request.headers.get('User-Agent'), data.touchPoints),
    }
    this.sql.exec(
      `INSERT INTO event_log (id, day, at, player, ip, event, mode, round, feature, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      day,
      now.toISOString(),
      data.player,
      ip ?? null,
      data.event,
      data.mode ?? null,
      data.round ?? null,
      data.feature ?? null,
      JSON.stringify(details),
    )
    if (['model_error', 'client_error'].includes(data.event))
      this.sql.exec(
        'INSERT INTO model_errors (id, day, at, player, ip, details) VALUES (?, ?, ?, ?, ?, ?)',
        data.id,
        day,
        now.toISOString(),
        data.player,
        ip ?? null,
        JSON.stringify({
          problem: data.problem ?? 'runtime',
          code: 'unknown',
          phase: 'unknown',
          backend: 'unknown',
          event: data.event,
          ...(fingerprint ? { fingerprint } : {}),
          ...(data.at ? { clientAt: data.at } : {}),
          ...dimensions,
          ...(data.round ? { round: data.round } : {}),
          ...(data.submission ? { submission: data.submission } : {}),
          ...Object.fromEntries(
            diagnosticFields
              .filter((key) => data[key] !== undefined)
              .map((key) => [key, data[key]]),
          ),
          ...deviceInfo(request.headers.get('User-Agent'), data.touchPoints),
        }),
      )
    if (ip)
      this.sql.exec(
        `INSERT INTO ip_counters (ip, day, player, event, dimensions, count) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT (ip, day, player, event, dimensions) DO UPDATE SET count = count + 1`,
        ip,
        day,
        data.player,
        data.event,
        roundDimensions,
      )
    return new Response(null, { status: 204 })
  }
}
