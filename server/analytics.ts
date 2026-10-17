import catalog from '../public/puzzles/index.json'
import { puzzleDay } from '../src/lib/day'
import { EVENTS, PROBLEMS } from '../src/lib/analytics'

interface Sql {
  exec(
    query: string,
    ...values: (string | number)[]
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
  'mode',
  'feature',
  'passage',
  'slot',
  'band',
  'attempt',
  'outcome',
  'problem',
] as const

// Only random browser IDs, daily activity, aggregate dimensions, and opaque
// deduplication hashes. No IPs, custom text, scores, or raw event history.
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
    `)
  }

  async fetch(request: Request) {
    const day = puzzleDay()
    if (request.method === 'GET') {
      const selected = new URL(request.url).searchParams.get('day') ?? day
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || selected > day)
        return json({ error: 'Invalid day.' }, 400)
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
      return json({ day: selected, ...players, practice, counters: counts })
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json'))
      return json({ error: 'Expected JSON.' }, 415)
    const text = await request.text()
    if (text.length > 1024) return json({ error: 'Event too large.' }, 413)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return json({ error: 'Invalid JSON.' }, 400)
    }
    if (
      !data ||
      typeof data.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.id) ||
      typeof data.player !== 'string' ||
      !uuid.test(data.player) ||
      !EVENTS.includes(data.event) ||
      Object.keys(data).some(
        (key) => !['id', 'player', 'event', ...fields].includes(key),
      ) ||
      (data.mode !== undefined && !['daily', 'practice'].includes(data.mode)) ||
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
      (data.problem !== undefined && !PROBLEMS.includes(data.problem))
    )
      return json({ error: 'Invalid event.' }, 400)
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
        .filter((key) => data[key] !== undefined)
        .map((key) => [key, data[key]]),
    )
    // These synchronous writes share the Durable Object's implicit transaction.
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
    return new Response(null, { status: 204 })
  }
}
