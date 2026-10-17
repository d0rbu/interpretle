import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from './results'
import { GameAnalytics } from './analytics'
import catalog from '../public/puzzles/index.json'

let db: DatabaseSync, analytics: GameAnalytics
function restart() {
  analytics = new GameAnalytics({
    storage: {
      sql: {
        exec(query, ...values) {
          if (query.trim().startsWith('CREATE')) {
            db.exec(query)
            return []
          }
          return db.prepare(query).all(...values) as Record<
            string,
            string | number
          >[]
        },
      },
    },
  })
}
const player = crypto.randomUUID()
const feature = catalog.practice[0]
const event = (
  name = 'visit',
  fields: Record<string, unknown> = {},
  id = crypto.randomUUID(),
) => ({
  id: createHash('sha256').update(id).digest('hex'),
  player,
  event: name,
  ...fields,
})
function request(body?: unknown, path = '/api/events', init: RequestInit = {}) {
  return worker.fetch(
    new Request('https://interpretle.com' + path, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      ...init,
    }),
    {
      RESULTS: {
        getByName() {
          throw new Error('Not the daily counter')
        },
      },
      ANALYTICS: { getByName: () => analytics },
      STATS_PASSWORD: 'a-test-password-not-used-in-production',
    },
  )
}
const stats = async (day?: string) =>
  (
    await analytics.fetch(
      new Request('https://internal/' + (day ? '?day=' + day : '')),
    )
  ).json()
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
  db = new DatabaseSync(':memory:')
  restart()
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

it('deduplicates retries and aggregates options and practice rounds without exposing player IDs', async () => {
  const start = event('game_start', { mode: 'practice', feature })
  const guess = event('guess', {
    mode: 'practice',
    feature,
    passage: 'prose:82:166-178',
    slot: 3,
    band: 90,
    attempt: 1,
  })
  const events = [
    event(),
    start,
    event('game_start', { mode: 'practice', feature }),
    guess,
    event('finish', { mode: 'practice', feature, outcome: 'won', attempt: 2 }),
  ]
  for (const data of [...events, ...events])
    expect((await request(data)).status).toBe(204)
  restart()
  await request(start)
  const result = await stats()
  expect(result).toMatchObject({
    day: '2026-10-18',
    players: 1,
    returning: 0,
    visits: 1,
    practiceRounds: 2,
    practice: [{ rounds: 2, players: 1 }],
  })
  expect(
    result.counters.find((row: { event: string }) => row.event === 'guess'),
  ).toMatchObject({
    passage: 'prose:82:166-178',
    slot: 3,
    band: 90,
    attempt: 1,
    count: 1,
  })
  expect(JSON.stringify(result)).not.toContain(player)
  expect([...db.prepare('SELECT * FROM seen').all()][0]).not.toHaveProperty(
    'player',
  )
})

it('recognizes a browser on another Pacific day and keeps daily activity separate', async () => {
  await request(event())
  vi.setSystemTime(new Date('2026-10-19T06:59:59Z'))
  await request(event('game_start', { mode: 'practice', feature }))
  expect((await stats()).practiceRounds).toBe(1)
  vi.setSystemTime(new Date('2026-10-19T07:00:00Z'))
  await request(event())
  await request(event('visit', { player: crypto.randomUUID() }))
  expect(await stats()).toMatchObject({
    day: '2026-10-19',
    players: 2,
    returning: 1,
    visits: 2,
    practiceRounds: 0,
  })
  expect(await stats('2026-10-18')).toMatchObject({
    players: 1,
    returning: 0,
    practiceRounds: 1,
  })
})

it('rejects text, raw errors, unknown targets, malformed fields, and cross-site writes', async () => {
  for (const fields of [
    { text: 'Never store this custom sentence.' },
    { tokens: [] },
    { error: 'raw error' },
    { feature: 'unknown' },
    { mode: 'unknown' },
    { passage: 'a custom sentence' },
    { slot: 6 },
    { band: 88.8 },
    { attempt: 9 },
    { outcome: 'unknown' },
    { problem: 'raw error' },
    { player: {} },
    { id: {} },
  ])
    expect((await request(event('guess', fields))).status).toBe(400)
  expect(
    (
      await request(event(), '/api/events', {
        headers: {
          Origin: 'https://other.example',
          'Content-Type': 'application/json',
        },
      })
    ).status,
  ).toBe(403)
  expect(
    (await request(event(), '/api/events', { body: 'x'.repeat(1025) })).status,
  ).toBe(413)
  expect((await request(event(), '/api/events', { body: '{' })).status).toBe(
    400,
  )
  expect((await request(undefined, '/api/events')).status).toBe(405)
  expect((await request(event(), '/api/stats')).status).toBe(404)
  expect((await request(undefined, '/api/stats?day=2099-01-01')).status).toBe(
    404,
  )
  expect(await stats()).toMatchObject({ players: 0, counters: [] })
})

it('redirects HTTP stats visits to HTTPS before requesting credentials or reading storage', async () => {
  for (const path of ['/admin', '/admin/?day=2026-10-18']) {
    const response = await worker.fetch(
      new Request('http://interpretle.com' + path),
      {
        get STATS_PASSWORD(): string {
          throw new Error('Must redirect before checking credentials')
        },
        RESULTS: {
          getByName() {
            throw new Error('Must redirect before reading storage')
          },
        },
      },
    )
    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe(
      'https://interpretle.com' + path,
    )
    expect(response.headers.has('WWW-Authenticate')).toBe(false)
  }
})

it('serves stats only on the private authenticated page and disables the old public API', async () => {
  await request(event())
  const password = 'a-test-password-not-used-in-production'
  for (const path of ['/admin', '/admin/']) {
    const denied = await request(undefined, path)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('WWW-Authenticate')).toContain('Basic')
    expect(await denied.text()).not.toContain('Browsers')
    expect(
      (
        await request(undefined, path, {
          headers: { Authorization: 'Basic ' + btoa('henry:wrong') },
        })
      ).status,
    ).toBe(401)
    const allowed = await request(undefined, path, {
      headers: { Authorization: 'Basic ' + btoa('henry:' + password) },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('Cache-Control')).toContain('private, no-store')
    expect(allowed.headers.get('Content-Security-Policy')).toContain(
      "frame-ancestors 'none'",
    )
    const html = await allowed.text()
    expect(html).toContain('Returning browsers')
    expect(html).toContain('<dd>1</dd>')
    expect(html).not.toContain(password)
    expect(html).not.toContain(player)
  }
  expect((await request(undefined, '/api/stats')).status).toBe(404)
  expect(
    (
      await request(undefined, '/admin?day=2099-01-01', {
        headers: { Authorization: 'Basic ' + btoa('henry:' + password) },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await worker.fetch(
        new Request('https://interpretle.com/admin', {
          headers: { Authorization: 'Basic ' + btoa('henry:' + password) },
        }),
        {
          RESULTS: {
            getByName() {
              throw new Error(
                'Must not read storage without a configured secret',
              )
            },
          },
        },
      )
    ).status,
  ).toBe(401)
})
