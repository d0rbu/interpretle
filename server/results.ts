import catalog from '../public/puzzles/index.json'

// Only the small slice of Cloudflare's bindings used by this counter.
interface Sql {
  exec(
    query: string,
    ...values: (string | number)[]
  ): Iterable<Record<string, string | number>>
}
interface Env {
  RESULTS: {
    getByName(day: string): { fetch(request: Request): Promise<Response> }
  }
}
const json = (body: object, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, no-transform' },
  })

// One small, persistent counter per day. A SQL trigger updates the eight
// buckets atomically, and duplicate browser submissions do not increment them.
export class DailyResults {
  sql: Sql
  constructor(state: { storage: { sql: Sql } }) {
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 8)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS totals (
        attempts INTEGER PRIMARY KEY, solves INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS count_solve AFTER INSERT ON submissions BEGIN
        INSERT INTO totals (attempts, solves) VALUES (NEW.attempts, 1)
        ON CONFLICT (attempts) DO UPDATE SET solves = solves + 1;
      END;
    `)
  }

  async fetch(request: Request) {
    if (request.method === 'POST') {
      if (!request.headers.get('Content-Type')?.startsWith('application/json'))
        return json({ error: 'Expected JSON.' }, 415)
      const text = await request.text()
      if (text.length > 256) return json({ error: 'Result too large.' }, 413)
      let result
      try {
        result = JSON.parse(text)
      } catch {
        return json({ error: 'Invalid JSON.' }, 400)
      }
      if (
        !result ||
        typeof result.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          result.id,
        ) ||
        !Number.isInteger(result.attempts) ||
        result.attempts < 1 ||
        result.attempts > 8
      )
        return json({ error: 'Invalid result.' }, 400)
      this.sql.exec(
        'INSERT OR IGNORE INTO submissions (id, attempts) VALUES (?, ?)',
        result.id,
        result.attempts,
      )
    }
    const counts = Array<number>(8).fill(0)
    for (const row of this.sql.exec('SELECT attempts, solves FROM totals'))
      counts[Number(row.attempts) - 1] = Number(row.solves)
    return json({ counts })
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const day = /^\/api\/results\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname)?.[1]
    if (
      !day ||
      !Object.hasOwn(catalog.daily, day) ||
      day > new Date().toISOString().slice(0, 10)
    )
      return json({ error: 'Unknown puzzle.' }, 404)
    if (!['GET', 'POST'].includes(request.method))
      return json({ error: 'Method not allowed.' }, 405)
    const origin = request.headers.get('Origin')
    if (request.method === 'POST' && origin && origin !== url.origin)
      return json({ error: 'Invalid origin.' }, 403)
    try {
      return await env.RESULTS.getByName(day).fetch(request)
    } catch {
      return json({ error: 'Results are temporarily unavailable.' }, 503)
    }
  },
}
