import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from './results'
import { GameAnalytics } from './analytics'
import catalog from '../public/puzzles/index.json'
import {
  feature as sampleFeature,
  catalog as sampleCatalog,
} from '../tests/fixture'
import { createGame, playCustom } from '../src/lib/game'
import { gameSnapshot } from '../src/lib/replay'
import { runtimeReport } from '../src/lib/diagnostics'
import { flowSteps } from './dashboard'
import type { Insights } from './insights'

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
      ASSETS: { fetch: async () => new Response('Static game') },
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
const fromIp = (body: unknown, ip: string) =>
  request(body, '/api/events', {
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  })
const stats = async (day?: string) =>
  (
    await analytics.fetch(
      new Request('https://internal/' + (day ? '?day=' + day : '')),
    )
  ).json()
const firefoxMac =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0.1'
const iphoneChrome =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1'
const auth = {
  Authorization:
    'Basic ' + btoa('henry:a-test-password-not-used-in-production'),
}
const replayFeature = { ...sampleFeature, id: feature }
const initialReplay = () =>
  gameSnapshot(
    createGame('daily', '2026-10-18', feature),
    replayFeature,
    sampleCatalog,
  )
const replayFields = () => ({
  mode: 'daily',
  round: '2026-10-18',
  feature,
  visit: crypto.randomUUID(),
  at: '2026-10-18T11:59:59.123Z',
  sequence: 1,
})
const gameExport = () =>
  `/admin?format=json&browser=${player}&mode=daily&round=2026-10-18&feature=${feature}`
const overview = async (query = ''): Promise<Insights> => {
  const result = await analytics.fetch(
    new Request(`https://internal/?view=dashboard&${query}`),
  )
  expect(result.status).toBe(200)
  return result.json()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
  db = new DatabaseSync(':memory:')
  restart()
})

it('stores bounded original exceptions privately, groups retries correctly, and preserves raw exports', async () => {
  const report = runtimeReport(
    new TypeError('<script>unsafe()</script> cache failed'),
    'Reading layer 4 weights',
    'weights',
    { release: 'test-build' },
  )
  report.stack =
    'TypeError: cache failed\n at read (https://interpretle.com/assets/worker-abcdefgh.js:2:5)'
  const payload = event('model_error', {
    problem: 'runtime',
    code: 'runtime',
    phase: 'weights',
    backend: 'gpu',
    report,
  })
  expect((await request(payload)).status).toBe(204)
  expect((await request(payload)).status).toBe(204)
  vi.setSystemTime(new Date('2026-10-18T12:00:05Z'))
  expect(
    (
      await request(
        event('model_error', {
          ...payload,
          id: event().id,
          report: { ...report, release: 'next-build' },
        }),
      )
    ).status,
  ).toBe(204)
  const data = await overview()
  expect(data.issues).toHaveLength(1)
  expect(data.issues[0]).toMatchObject({
    count: 2,
    players: 1,
    firstAt: '2026-10-18T12:00:00.000Z',
    lastAt: '2026-10-18T12:00:05.000Z',
  })
  expect(data.issues[0].samples).toHaveLength(2)
  expect(data.coverage).toMatchObject({ errorRecords: 2, exceptions: 2 })
  const counters = (await stats()).counters
  expect(JSON.stringify(counters)).not.toMatch(
    /unsafe|read \(|test-build|fingerprint/,
  )
  const exported = await (
    await request(undefined, '/admin/raw?format=json', { headers: auth })
  ).json()
  expect(exported.events[0].report).toEqual(report)
  expect(exported.events[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
  const page = await request(undefined, '/admin', { headers: auth })
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('Original exception')
  expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
  expect(html).not.toContain('<script>unsafe()')
  expect(html).toContain('/admin/raw?browser=')
  for (const path of ['/admin', '/admin/raw?format=json', '/admin/anything'])
    expect((await request(undefined, path)).status).toBe(401)
})

it('accepts page crashes and rejects malformed or misplaced original reports', async () => {
  const report = runtimeReport(
    'Unexpected rejection',
    'Unhandled promise',
    'promise',
  )
  expect(
    (await request(event('client_error', { report, problem: 'runtime' })))
      .status,
  ).toBe(204)
  expect((await overview()).issues[0].samples[0].details.report?.source).toBe(
    'promise',
  )
  for (const body of [
    event('visit', { report }),
    event('model_error', { report: { ...report, extra: 'x' } }),
    event('model_error', { report: { ...report, stack: 'x'.repeat(12001) } }),
    event('client_error', { report: { ...report, source: 'arbitrary' } }),
  ])
    expect((await request(body)).status).toBe(400)
  expect(
    (
      await request(
        event('client_error', {
          report: { ...report, stack: 'x'.repeat(33000) },
        }),
      )
    ).status,
  ).toBe(413)
})

it('builds a conserving game-flow cohort without inventing paths for restored histories', async () => {
  const seed = (
    n: number,
    outcome: 'open' | 'won' | 'lost',
    fromStart = true,
    limit = 6,
    mode = 'daily',
  ) => {
    const browser = crypto.randomUUID(),
      round = mode === 'daily' ? '2026-10-18' : crypto.randomUUID()
    const insert = (guesses: number, status: string, eventName: string) => {
      db.prepare(
        `INSERT INTO event_log (id,day,at,player,event,mode,round,feature,details) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        crypto.randomUUID(),
        '2026-10-18',
        '2026-10-18T12:00:00.000Z',
        browser,
        eventName,
        mode,
        round,
        feature,
        JSON.stringify({
          snapshot: {
            status,
            game: { maxGuesses: limit, guesses: Array(guesses).fill({}) },
          },
        }),
      )
    }
    if (fromStart) insert(0, 'playing', 'puzzle_view')
    insert(n, outcome === 'open' ? 'playing' : outcome, 'guess')
  }
  seed(0, 'open')
  seed(2, 'won')
  seed(3, 'open')
  seed(6, 'lost')
  seed(4, 'open', false)
  seed(8, 'won', true, 8, 'practice')
  const data = await overview('days=7')
  const flow = flowSteps(data.flow)
  expect(flow).toMatchObject({ total: 5, skipped: 1 })
  expect(flow.steps[0]).toMatchObject({ reached: 5, next: 4, open: 1 })
  expect(flow.steps[2].won).toBe(1)
  expect(flow.steps[3].open).toBe(1)
  expect(flow.steps[6].lost).toBe(1)
  expect(flow.steps[8].won).toBe(1)
  for (const step of flow.steps)
    expect(step.reached).toBe(step.next + step.won + step.lost + step.open)
  expect(flowSteps((await overview('game=practice')).flow)).toMatchObject({
    total: 1,
    skipped: 0,
  })
})

it('plots Pacific receipt days, unique browsers, returns and zero days using all aggregate history', async () => {
  vi.setSystemTime(new Date('2026-10-17T23:00:00Z'))
  await request(event('visit'))
  await request(event('game_start', { mode: 'practice' }))
  // 06:59 UTC remains October 17 in Pacific local time.
  vi.setSystemTime(new Date('2026-10-18T06:59:00Z'))
  await request(event('model_error', { problem: 'runtime' }))
  vi.setSystemTime(new Date('2026-10-18T07:01:00Z'))
  await request(event('visit'))
  await request(event('visit', { player: crypto.randomUUID() }))
  await request(event('game_start', { mode: 'daily' }))
  const data = await overview('days=7&game=daily')
  expect(data.series).toHaveLength(7)
  expect(data.series[0]).toMatchObject({
    day: '2026-10-12',
    browsers: 0,
    games: 0,
    errors: 0,
  })
  expect(data.series[5]).toMatchObject({
    day: '2026-10-17',
    browsers: 1,
    visits: 1,
    games: 0,
    errors: 1,
  })
  expect(data.series[6]).toMatchObject({
    day: '2026-10-18',
    browsers: 2,
    returning: 1,
    games: 1,
    visits: 2,
  })
  expect(data.people).toEqual({ browsers: 2, returning: 1 })
  for (const query of ['days=900', 'game=other', 'day=2026-02-31'])
    expect(
      (await request(undefined, '/admin?' + query, { headers: auth })).status,
    ).toBe(400)
})

it('stores server receipt times and reported device details once per model error', async () => {
  const data = event('model_error', {
    problem: 'storage',
    code: 'storage_full',
    phase: 'tokenizer',
    backend: 'unknown',
    cores: 8,
  })
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': firefoxMac,
    'CF-Connecting-IP': '203.0.113.8',
  }
  expect((await request(data, '/api/events', { headers })).status).toBe(204)
  vi.setSystemTime(new Date('2026-10-18T12:05:00Z'))
  restart()
  expect((await request(data, '/api/events', { headers })).status).toBe(204)
  const result = await stats()
  expect(result.modelErrors).toHaveLength(1)
  expect(result.modelErrors[0]).toMatchObject({
    at: '2026-10-18T12:00:00.000Z',
    player,
    ip: '203.0.113.8',
    code: 'storage_full',
    phase: 'tokenizer',
    backend: 'unknown',
    browser: 'Firefox 157.0.1',
    os: 'macOS',
    device: 'desktop',
    cores: 8,
    userAgent: firefoxMac,
  })
  expect(result.modelErrors[0]).not.toHaveProperty('memoryGb')
  expect(result.modelErrorGroups).toEqual([
    expect.objectContaining({
      code: 'storage_full',
      browser: 'Firefox 157.0.1',
      count: 1,
    }),
  ])
  expect(
    result.counters.find(
      (row: { event: string }) => row.event === 'model_error',
    ).count,
  ).toBe(1)
})

it('filters model errors by Pacific day, browser, or source IP and shows them only in private reports', async () => {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': iphoneChrome,
    'CF-Connecting-IP': '203.0.113.9',
  }
  const detail = {
    problem: 'network',
    code: 'http',
    phase: 'weights',
    backend: 'cpu',
    httpStatus: 503,
    cores: 6,
  }
  await request(event('model_error', detail), '/api/events', { headers })
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  await request(event('model_error', detail), '/api/events', { headers })
  await request(
    event('model_error', { ...detail, player: crypto.randomUUID() }),
    '/api/events',
    {
      headers: { ...headers, 'CF-Connecting-IP': '203.0.113.10' },
    },
  )
  expect((await stats('2026-10-18')).modelErrors).toHaveLength(1)
  expect((await stats()).modelErrors).toHaveLength(2)
  const byBrowser = await (
    await analytics.fetch(new Request(`https://internal/?browser=${player}`))
  ).json()
  expect(byBrowser.modelErrors).toHaveLength(2)
  const byIp = await (
    await analytics.fetch(new Request('https://internal/?ip=203.0.113.9'))
  ).json()
  expect(byIp.modelErrors).toHaveLength(2)
  expect(byIp.modelErrors[0]).toMatchObject({
    at: '2026-10-19T12:00:00.000Z',
    device: 'phone',
    os: 'iOS',
    browser: 'Chrome 141.0.7390.41',
    httpStatus: 503,
  })
  const privateResponse = await request(undefined, `/admin?browser=${player}`, {
    headers: {
      Authorization:
        'Basic ' + btoa('henry:a-test-password-not-used-in-production'),
    },
  })
  const html = await privateResponse.text()
  expect(html).toContain('Model errors')
  expect(html).toContain('2026-10-19 12:00:00 UTC')
  expect(html).toContain('Chrome 141.0.7390.41')
  expect(html).toContain('HTTP 503')
  for (const path of [
    `/admin?browser=${player}`,
    '/api/stats',
    '/api/events',
  ]) {
    const denied = await request(undefined, path)
    expect([401, 404, 405]).toContain(denied.status)
    expect(await denied.text()).not.toContain('Chrome 141.0.7390.41')
  }
})

it('keeps full device error counts while limiting detailed reports to the latest 200', async () => {
  for (let i = 0; i < 205; i++) {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 12, 0, i)))
    await request(
      event('model_error', {
        problem: 'runtime',
        code: 'runtime',
        phase: 'runtime',
        backend: 'cpu',
      }),
    )
  }
  const result = await stats()
  expect(result.modelErrors).toHaveLength(200)
  expect(result.modelErrors[0].at).toBe('2026-10-18T12:03:24.000Z')
  expect(result.modelErrorGroups).toEqual([
    expect.objectContaining({ count: 205 }),
  ])
})

it('accepts errors from older clients with unknown diagnostics and escapes reported user agents', async () => {
  const userAgent = '<script>alert("x")</script>'
  await request(event('model_error', { problem: 'memory' }), '/api/events', {
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
  })
  expect((await stats()).modelErrors[0]).toMatchObject({
    code: 'unknown',
    phase: 'unknown',
    backend: 'unknown',
    device: 'unknown',
    userAgent,
  })
  const response = await request(undefined, '/admin/raw', {
    headers: {
      Authorization:
        'Basic ' + btoa('henry:a-test-password-not-used-in-production'),
    },
  })
  const html = await response.text()
  expect(html).not.toContain(userAgent)
  expect(html).toContain('&lt;script&gt;')
})

it('rejects raw diagnostic strings, client timestamps, invalid values, and hardware fields on gameplay events', async () => {
  for (const detail of [
    { at: '2026-01-01' },
    { userAgent: 'fake' },
    { message: 'PRIVATE TEXT' },
    { code: 'PRIVATE TEXT' },
    { phase: 'PRIVATE TEXT' },
    { backend: 'mlx' },
    { httpStatus: 999 },
    { httpStatus: '503' },
    { layer: -1 },
    { layer: 1.5 },
    { cores: 0 },
    { cores: 1025 },
    { memoryGb: -1 },
    { memoryGb: '8' },
    { touchPoints: -1 },
    { touchPoints: 0.5 },
  ])
    expect((await request(event('model_error', detail))).status).toBe(400)
  expect((await request(event('visit', { cores: 8 }))).status).toBe(400)
  expect((await stats()).modelErrors).toEqual([])
})

it('keeps a private, replayable game history with distinct event and receipt times and exact submitted write-ins', async () => {
  const fields = replayFields()
  const snapshot = initialReplay()
  const view = event('puzzle_view', { ...fields, snapshot })
  expect((await request(view)).status).toBe(204)
  const input = 'A café. <script>alert(1)</script>'
  const submission = crypto.randomUUID()
  expect(
    (
      await request(
        event('guess_submit', {
          ...fields,
          sequence: 2,
          at: '2026-10-18T12:00:01.001Z',
          submission,
          attempt: 1,
          text: input,
          snapshot,
        }),
      )
    ).status,
  ).toBe(204)
  const tokens = [{ id: 7, start: 0, end: input.length, activation: 0.5 }]
  const game = playCustom(snapshot.game, replayFeature, input, tokens, true)
  vi.setSystemTime(new Date('2026-10-18T12:00:03.456Z'))
  expect(
    (
      await request(
        event('guess', {
          ...fields,
          sequence: 3,
          at: '2026-10-18T12:00:02.002Z',
          submission,
          attempt: 1,
          snapshot: gameSnapshot(game, replayFeature, sampleCatalog),
        }),
      )
    ).status,
  ).toBe(204)
  restart()
  expect((await request(view)).status).toBe(204)
  const response = await request(undefined, gameExport(), { headers: auth })
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toContain('private')
  expect(response.headers.get('Content-Disposition')).toContain('attachment')
  const saved = await response.json()
  expect(saved.events).toHaveLength(3)
  expect(saved.events.map((e: { sequence: number }) => e.sequence)).toEqual([
    1, 2, 3,
  ])
  expect(saved.events[0]).toMatchObject({
    at: fields.at,
    receivedAt: '2026-10-18T12:00:00.000Z',
  })
  expect(saved.events[0].snapshot.options).toEqual(snapshot.options)
  expect(saved.events[1]).toMatchObject({ text: input, submission })
  expect(saved.events[2].snapshot.game).toEqual(game)
  expect(saved.events[2].snapshot.game.guesses[0].tokens).toEqual(tokens)
  const html = await (
    await request(undefined, gameExport().replace('format=json&', ''), {
      headers: auth,
    })
  ).text()
  expect(html).toContain('Game timeline')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>alert(1)</script>')
  for (const path of [
    gameExport(),
    '/admin?format=json',
    '/api/events?format=json',
    '/api/stats?format=json',
  ]) {
    const denied = await request(undefined, path)
    expect([401, 404, 405]).toContain(denied.status)
    expect(await denied.text()).not.toContain(input)
  }
})

it('paginates complete history and isolates game and browser selections', async () => {
  const fields = replayFields()
  await request(event('puzzle_view', { ...fields, snapshot: initialReplay() }))
  for (let i = 0; i < 101; i++)
    await request(
      event('context', {
        ...fields,
        sequence: i + 2,
        passage: 'prose:1:0-9',
        expanded: i % 2 === 0,
      }),
    )
  await request(event('visit', { player: crypto.randomUUID() }))
  await request(event('puzzle_view', { ...fields, round: '2026-10-17' }))
  const first = await (
    await request(undefined, gameExport(), { headers: auth })
  ).json()
  expect(first.events).toHaveLength(100)
  expect(first.nextCursor).toBe(first.events.at(-1).seq)
  const second = await (
    await request(undefined, gameExport() + '&after=' + first.nextCursor, {
      headers: auth,
    })
  ).json()
  expect(second.events).toHaveLength(2)
  expect(second.nextCursor).toBeNull()
  expect(
    new Set(
      [...first.events, ...second.events].map((e: { id: string }) => e.id),
    ).size,
  ).toBe(102)
  expect(
    [...first.events, ...second.events].every(
      (e: { round: string }) => e.round === '2026-10-18',
    ),
  ).toBe(true)
  expect(
    (
      await request(undefined, '/admin?format=json&round=2026-10-18', {
        headers: auth,
      })
    ).status,
  ).toBe(400)
})

it('rejects malformed snapshots, unsolicited draft text, and invalid replay metadata before saving anything', async () => {
  const fields = replayFields()
  const valid = initialReplay()
  for (const snapshot of [
    { ...valid, game: { ...valid.game, seed: '2026-10-17' } },
    { ...valid, options: [...valid.options, ...valid.options] },
    { ...valid, feature: { ...valid.feature, displayScale: -1 } },
    {
      ...valid,
      game: {
        ...valid.game,
        guesses: [
          {
            kind: 'custom',
            text: 'bad',
            tokens: [{ id: 1, start: 0, end: 99, activation: 1 }],
            rawMax: 1,
            score: 50,
          },
        ],
      },
    },
  ])
    expect(
      (await request(event('puzzle_view', { ...fields, snapshot }))).status,
    ).toBe(400)
  for (const extra of [
    { text: 'An unsubmitted draft' },
    { sequence: -1 },
    { visit: 'bad' },
    { at: 'not a timestamp' },
  ])
    expect(
      (await request(event('puzzle_view', { ...fields, ...extra }))).status,
    ).toBe(400)
  const exported = await (
    await request(undefined, '/admin?format=json', { headers: auth })
  ).json()
  expect(exported.events).toEqual([])
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

it('deduplicates retries and keeps browser breakdowns behind the private stats page', async () => {
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
  expect(result.browsers).toContainEqual(
    expect.objectContaining({ id: player, guesses: 1, writeins: 0, wins: 1 }),
  )
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

it('preserves existing data and privately aggregates selected and displayed themes', async () => {
  await request(event())
  const themes = [
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'light'],
    ['system', 'dark'],
  ]
  const events = themes.map(([themePreference, theme]) =>
    event('theme', { themePreference, theme }),
  )
  for (const data of events) expect((await request(data)).status).toBe(204)
  restart()
  for (const data of events) expect((await request(data)).status).toBe(204)
  const result = await stats()
  expect(result.visits).toBe(1)
  const counters = result.counters.filter(
    (row: { event: string }) => row.event === 'theme',
  )
  expect(counters).toHaveLength(4)
  for (const [themePreference, theme] of themes)
    expect(counters).toContainEqual({
      event: 'theme',
      themePreference,
      theme,
      count: 1,
    })
  const response = await request(undefined, '/admin/raw', {
    headers: {
      Authorization:
        'Basic ' + btoa('henry:a-test-password-not-used-in-production'),
    },
  })
  const html = await response.text()
  expect(html).toContain('Color theme usage')
  expect(html).toContain('<td>System</td><td>Light</td><td>1</td>')
  expect(html).toContain('<td>System</td><td>Dark</td><td>1</td>')
  expect((await request(undefined, '/admin')).status).toBe(401)
  expect((await request(undefined, '/api/stats')).status).toBe(404)
})

it('rejects text, raw errors, unknown targets, malformed fields, and cross-site writes', async () => {
  for (const fields of [
    { text: 'Never store this custom sentence.' },
    { tokens: [] },
    { ip: '203.0.113.8' },
    { error: 'raw error' },
    { feature: 'unknown' },
    { mode: 'unknown' },
    { round: '2026-10-18' },
    { mode: 'daily', round: crypto.randomUUID() },
    { mode: 'practice', round: '2026-10-18' },
    { mode: 'daily', round: {} },
    { passage: 'a custom sentence' },
    { slot: 6 },
    { band: 88.8 },
    { attempt: 9 },
    { outcome: 'unknown' },
    { problem: 'raw error' },
    { theme: 'system' },
    { theme: 'dark', themePreference: 'light' },
    { themePreference: 'auto' },
    { player: {} },
    { id: {} },
  ])
    expect((await request(event('guess', fields))).status).toBe(400)
  expect((await request(event('theme'))).status).toBe(400)
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
  for (const path of ['/admin', '/admin/?day=2026-10-18', '/admin/raw']) {
    const response = await worker.fetch(
      new Request('http://interpretle.com' + path),
      {
        get ASSETS(): never {
          throw new Error('Must redirect before serving assets')
        },
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
  for (const path of ['/admin', '/admin/', '/admin/raw', '/admin/raw/']) {
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
    expect(html).toContain('Browsers')
    expect(html).toContain(
      path.includes('/raw') ? '<dd>1</dd>' : 'Game overview',
    )
    expect(html).not.toContain(password)
    if (path.includes('/raw')) expect(html).toContain('browser=' + player)
    else expect(html).toContain('From opening the puzzle to the final guess')
  }
  expect((await request(undefined, '/api/stats')).status).toBe(404)
  expect(
    (
      await request(undefined, '/admin?day=2099-01-01', {
        headers: { Authorization: 'Basic ' + btoa('henry:' + password) },
      })
    ).status,
  ).toBe(400)
  for (const [browser, status] of [
    ['not-an-id', 400],
    [crypto.randomUUID(), 404],
  ] as const)
    expect(
      (
        await request(undefined, '/admin?browser=' + browser, {
          headers: { Authorization: 'Basic ' + btoa('henry:' + password) },
        })
      ).status,
    ).toBe(status)
  expect(
    (
      await worker.fetch(
        new Request('https://interpretle.com/admin', {
          headers: { Authorization: 'Basic ' + btoa('henry:' + password) },
        }),
        {
          ASSETS: { fetch: async () => new Response('Static game') },
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

it('correlates themes, submitted write-ins and round history for one browser across days', async () => {
  const round = crypto.randomUUID()
  const base = {
    mode: 'practice',
    feature,
    round,
    themePreference: 'dark',
    theme: 'dark',
  }
  const events = [
    event(),
    event('theme', { themePreference: 'dark', theme: 'dark' }),
    event('game_start', base),
    event('writein_open', { ...base, attempt: 1 }),
    event('guess', { ...base, attempt: 1 }),
    event('guess', { ...base, attempt: 2, passage: 'prose:82:166-178' }),
    event('finish', { ...base, attempt: 2, outcome: 'won' }),
    event('finish', {
      player: crypto.randomUUID(),
      mode: 'daily',
      feature,
      round: '2026-10-18',
      attempt: 6,
      outcome: 'lost',
    }),
  ]
  for (const data of [...events, ...events])
    expect((await request(data)).status).toBe(204)
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  await request(event())
  await request(event('theme', { themePreference: 'system', theme: 'light' }))
  await request(
    event('finish', {
      mode: 'daily',
      feature,
      round: '2026-10-19',
      attempt: 3,
      outcome: 'won',
      themePreference: 'system',
      theme: 'light',
    }),
  )
  restart()
  const response = await analytics.fetch(
    new Request('https://internal/?browser=' + player),
  )
  const { browser } = await response.json()
  expect(browser).toMatchObject({
    id: player,
    firstDay: '2026-10-18',
    visits: 2,
    practiceRounds: 1,
    guesses: 2,
    writeins: 1,
    wins: 2,
    losses: 0,
  })
  expect(browser.themes).toContain('dark / dark')
  expect(browser.themes).toContain('system / light')
  expect(browser.history).toHaveLength(2)
  expect(browser.history[1]).toMatchObject({
    round,
    mode: 'practice',
    attempt: 2,
    outcome: 'won',
    theme: 'dark',
    count: 1,
  })
  const privatePage = await request(undefined, '/admin?browser=' + player, {
    headers: {
      Authorization:
        'Basic ' + btoa('henry:a-test-password-not-used-in-production'),
    },
  })
  const html = await privatePage.text()
  expect(html).toContain('Latest 200 completed rounds')
  expect(html).toContain('1 write-ins / 2 guesses')
  expect(html).toContain(round)
  for (const path of [
    '/admin?browser=' + player,
    '/api/events?browser=' + player,
    '/api/stats?browser=' + player,
  ]) {
    const denied = await request(undefined, path)
    expect([401, 404, 405]).toContain(denied.status)
    expect(await denied.text()).not.toContain(player)
  }
})

it('groups shared IPs without attributing a browser’s other-IP activity to them', async () => {
  const ip = '203.0.113.8'
  const otherIp = '198.51.100.4'
  const otherBrowser = crypto.randomUUID()
  const round = crypto.randomUUID()
  const base = {
    mode: 'practice',
    round,
    feature,
    themePreference: 'dark',
    theme: 'dark',
  }
  const events = [
    event(),
    event('theme', { themePreference: 'dark', theme: 'dark' }),
    event('game_start', base),
    event('guess', { ...base, attempt: 1 }),
    event('guess', { ...base, attempt: 2, passage: 'prose:82:166-178' }),
    event('finish', { ...base, attempt: 6, outcome: 'lost' }),
    event('visit', { player: otherBrowser }),
    event('theme', {
      player: otherBrowser,
      themePreference: 'system',
      theme: 'light',
    }),
    event('finish', {
      player: otherBrowser,
      mode: 'daily',
      round: '2026-10-18',
      feature,
      attempt: 3,
      outcome: 'won',
      themePreference: 'system',
      theme: 'light',
    }),
  ]
  for (const data of [...events, ...events])
    expect((await fromIp(data, ip)).status).toBe(204)
  expect(await stats()).toMatchObject({
    players: 2,
    visits: 2,
    practiceRounds: 1,
    ipCount: 1,
    ips: [
      {
        id: ip,
        browserCount: 2,
        visits: 2,
        practiceRounds: 1,
        guesses: 2,
        writeins: 1,
        wins: 1,
        losses: 1,
      },
    ],
  })

  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  await fromIp(event(), otherIp)
  await fromIp(
    event('finish', {
      mode: 'daily',
      round: '2026-10-19',
      feature,
      attempt: 4,
      outcome: 'won',
      themePreference: 'system',
      theme: 'dark',
    }),
    otherIp,
  )
  // A retry received from a different address must not move or duplicate it.
  await fromIp(events[5], otherIp)
  restart()
  const details = async (query: string) =>
    (await analytics.fetch(new Request('https://internal/?' + query))).json()
  const first = await details('ip=' + ip)
  expect(first).toMatchObject({ ipCount: 1, ips: [{ id: otherIp }] })
  expect(first.ip).toMatchObject({
    id: ip,
    firstDay: '2026-10-18',
    lastDay: '2026-10-18',
    browserCount: 2,
    visits: 2,
    practiceRounds: 1,
    guesses: 2,
    writeins: 1,
    wins: 1,
    losses: 1,
  })
  expect(first.ip.themes).toContain('dark / dark')
  expect(first.ip.themes).toContain('system / light')
  expect(first.ip.themes).not.toContain('system / dark')
  expect(first.ip.browsers).toHaveLength(2)
  expect(first.ip.browsers).toContainEqual(
    expect.objectContaining({
      id: player,
      wins: 0,
      losses: 1,
      writeins: 1,
    }),
  )
  expect(first.ip.history).toHaveLength(2)
  expect(first.ip.history).toContainEqual(
    expect.objectContaining({
      player,
      round,
      outcome: 'lost',
      attempt: 6,
      count: 1,
    }),
  )
  const second = (await details('ip=' + otherIp)).ip
  expect(second).toMatchObject({
    browserCount: 1,
    visits: 1,
    practiceRounds: 0,
    guesses: 0,
    writeins: 0,
    wins: 1,
    losses: 0,
    themes: 'system / dark',
  })
  expect(second.history).toHaveLength(1)
  expect(second.counters).toContainEqual(
    expect.objectContaining({
      event: 'finish',
      outcome: 'won',
      attempt: 4,
      count: 1,
    }),
  )
  expect(first.ip.counters).toEqual([])
  const pastIp = (await details('ip=' + ip + '&day=2026-10-18')).ip
  expect(pastIp.counters).toContainEqual(
    expect.objectContaining({
      event: 'guess',
      passage: 'prose:82:166-178',
      count: 1,
    }),
  )
  expect(
    pastIp.counters.every((row: Record<string, unknown>) => !row.round),
  ).toBe(true)
  const person = (await details('browser=' + player)).browser
  expect(person).toMatchObject({ visits: 2, wins: 1, losses: 1, writeins: 1 })
  expect(person.addresses).toEqual([
    { id: otherIp, firstDay: '2026-10-19', lastDay: '2026-10-19' },
    { id: ip, firstDay: '2026-10-18', lastDay: '2026-10-18' },
  ])
  expect(await stats('2026-10-18')).toMatchObject({ ipCount: 1, visits: 2 })
})

it('normalizes IPv6 and accepts only a single valid Cloudflare-provided address', async () => {
  for (const ip of ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'])
    expect((await fromIp(event(), ip)).status).toBe(204)
  for (const ip of [
    'example.com',
    'deadbeef',
    '127.1',
    '2130706433',
    '001.2.3.4',
    '256.1.2.3',
    '2001:db8::1::2',
    'fe80::1%en0',
    '[2001:db8::1]',
    '203.0.113.8:443',
    '203.0.113.8,198.51.100.4',
  ])
    expect((await fromIp(event(), ip)).status).toBe(204)
  await request(event(), '/api/events', {
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '192.0.2.20',
      'X-Real-IP': '192.0.2.20',
      'CF-Connecting-IPv6': '2001:db8::bad',
    },
  })
  await request(event(), '/api/events', {
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.8',
      'X-Forwarded-For': '192.0.2.20',
      'X-Real-IP': '192.0.2.20',
      'CF-Connecting-IPv6': '2001:db8::bad',
    },
  })
  const result = await stats()
  expect(result).toMatchObject({ ipCount: 2 })
  expect(result.ips).toContainEqual(
    expect.objectContaining({ id: '2001:db8::1', visits: 2 }),
  )
  expect(result.ips).toContainEqual(
    expect.objectContaining({ id: '203.0.113.8', visits: 1 }),
  )
  expect(result.counters).toEqual([{ event: 'visit', count: 15 }])
  const response = await analytics.fetch(
    new Request(
      'https://internal/?ip=' + encodeURIComponent('2001:0DB8:0:0:0:0:0:1'),
    ),
  )
  expect((await response.json()).ip).toMatchObject({
    id: '2001:db8::1',
    visits: 2,
  })
})

it('keeps IP addresses and histories behind admin authentication', async () => {
  const ip = '203.0.113.8'
  await fromIp(event(), ip)
  for (const path of [
    '/admin?ip=' + ip,
    '/admin?browser=' + player,
    '/api/events?ip=' + ip,
    '/api/stats?ip=' + ip,
  ]) {
    const response = await request(undefined, path)
    expect([401, 404, 405]).toContain(response.status)
    expect(await response.text()).not.toContain(ip)
  }
  const headers = {
    Authorization:
      'Basic ' + btoa('henry:a-test-password-not-used-in-production'),
  }
  const response = await request(undefined, '/admin?ip=' + ip, { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toContain('private, no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  const html = await response.text()
  expect(html).toContain('<h2>IP ' + ip + '</h2>')
  expect(html).toContain('browser=' + player)
  expect(html).toContain('ip=' + ip)
  expect(html).toContain('Browsers seen at this IP')
  const browser = await request(undefined, '/admin?browser=' + player, {
    headers,
  })
  expect(await browser.text()).toContain('ip=' + ip)
  for (const [value, status] of [
    ['192.0.2.99', 404],
    ['<script>alert(1)</script>', 400],
  ]) {
    const invalid = await request(
      undefined,
      '/admin?ip=' + encodeURIComponent(value),
      { headers },
    )
    expect(invalid.status).toBe(status)
    expect(await invalid.text()).not.toContain(value)
  }
})

it('adds IP storage without resetting or backfilling older browser counters', async () => {
  const oldVisit = event()
  await request(oldVisit)
  // Simulate the schema that was deployed before IP tracking.
  db.exec('DROP TABLE ip_counters')
  restart()
  await fromIp(oldVisit, '203.0.113.8')
  expect(await stats()).toMatchObject({ visits: 1, ipCount: 0, ips: [] })
  await fromIp(event(), '203.0.113.8')
  expect(await stats()).toMatchObject({
    players: 1,
    visits: 2,
    ipCount: 1,
    browsers: [expect.objectContaining({ id: player, visits: 2 })],
    ips: [expect.objectContaining({ id: '203.0.113.8', visits: 1 })],
  })
})
