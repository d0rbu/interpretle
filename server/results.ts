import catalog from '../public/puzzles/index.json'
import { puzzleDay } from '../src/lib/day'
import { authorized, statsPage } from './admin'
import { dashboardPage } from './dashboard'
export { GameAnalytics } from './analytics'

// Only the small slice of Cloudflare's bindings used by this counter.
interface Sql {
  exec(
    query: string,
    ...values: (string | number)[]
  ): Iterable<Record<string, string | number>>
}
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  STATS_PASSWORD?: string
  ANALYTICS?: {
    getByName(name: string): { fetch(request: Request): Promise<Response> }
  }
  RESULTS: {
    getByName(day: string): { fetch(request: Request): Promise<Response> }
  }
}
const json = (body: object, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, no-transform' },
  })

// One persistent counter per day. SQL triggers update the buckets atomically;
// a browser's first completed result wins, including retries after a restart.
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
      CREATE TABLE IF NOT EXISTS failures (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS count_solve AFTER INSERT ON submissions BEGIN
        INSERT INTO totals (attempts, solves) VALUES (NEW.attempts, 1)
        ON CONFLICT (attempts) DO UPDATE SET solves = solves + 1;
      END;
      CREATE TRIGGER IF NOT EXISTS count_failure AFTER INSERT ON failures BEGIN
        INSERT INTO totals (attempts, solves) VALUES (0, 1)
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
        result.attempts < 0 ||
        result.attempts > 8
      )
        return json({ error: 'Invalid result.' }, 400)
      // Zero means all guesses were used without a solve. A separate
      // table preserves the original submissions schema and existing results.
      if (result.attempts === 0)
        this.sql.exec(
          'INSERT OR IGNORE INTO failures (id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE id = ?)',
          result.id,
          result.id,
        )
      else
        this.sql.exec(
          'INSERT OR IGNORE INTO submissions (id, attempts) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM failures WHERE id = ?)',
          result.id,
          result.attempts,
          result.id,
        )
    }
    const counts = Array<number>(8).fill(0)
    let failed = 0
    for (const row of this.sql.exec('SELECT attempts, solves FROM totals')) {
      if (Number(row.attempts) === 0) failed = Number(row.solves)
      else counts[Number(row.attempts) - 1] = Number(row.solves)
    }
    return json({ counts, failed })
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    // The game uses browser APIs that require a secure context.
    if (url.protocol === 'http:' && url.hostname === 'interpretle.com') {
      url.protocol = 'https:'
      return Response.redirect(url.href, 308)
    }
    if (url.pathname === '/' || url.pathname === '/index.html')
      return env.ASSETS.fetch(request)
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (url.protocol !== 'https:') {
        url.protocol = 'https:'
        return Response.redirect(url.href, 308)
      }
      if (!(await authorized(request, env.STATS_PASSWORD)))
        return new Response('Authentication required.', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Basic realm="Interpretle stats", charset="UTF-8"',
            'Cache-Control': 'private, no-store, no-transform',
          },
        })
      if (request.method !== 'GET')
        return json({ error: 'Method not allowed.' }, 405)
      if (
        !['/admin', '/admin/', '/admin/raw', '/admin/raw/'].includes(
          url.pathname,
        )
      )
        return json({ error: 'Not found.' }, 404)
      try {
        if (!env.ANALYTICS) throw new Error('Unavailable')
        // Keep existing bookmarked browser/game links and JSON exports working.
        const raw =
          url.pathname.startsWith('/admin/raw') ||
          ['browser', 'ip', 'round', 'format'].some((key) =>
            url.searchParams.has(key),
          )
        if (!raw) url.searchParams.set('view', 'dashboard')
        const data = await env.ANALYTICS.getByName('gameplay').fetch(
          new Request(url, request),
        )
        return raw
          ? await statsPage(data, url.searchParams.get('format') === 'json')
          : await dashboardPage(data)
      } catch {
        return json({ error: 'Counters are temporarily unavailable.' }, 503)
      }
    }
    if (url.pathname === '/api/events') {
      const method = 'POST'
      if (request.method !== method)
        return json({ error: 'Method not allowed.' }, 405)
      const origin = request.headers.get('Origin')
      if (method === 'POST' && origin && origin !== url.origin)
        return json({ error: 'Invalid origin.' }, 403)
      try {
        if (!env.ANALYTICS) throw new Error('Unavailable')
        return await env.ANALYTICS.getByName('gameplay').fetch(request)
      } catch {
        return json({ error: 'Counters are temporarily unavailable.' }, 503)
      }
    }
    const day = /^\/api\/results\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname)?.[1]
    if (!day || !Object.hasOwn(catalog.daily, day) || day > puzzleDay())
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
