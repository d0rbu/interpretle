import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { DailyResults } from './results'

const databases = new Map<string, DatabaseSync>()
const counters = new Map<string, DailyResults>()
function counter(day: string) {
  if (!databases.has(day)) databases.set(day, new DatabaseSync(':memory:'))
  const db = databases.get(day)!
  return new DailyResults({
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
const env = {
  ASSETS: { fetch: async () => new Response('Static game') },
  RESULTS: {
    getByName(day: string) {
      if (!counters.has(day)) counters.set(day, counter(day))
      return counters.get(day)!
    },
  },
}
function request(day = '2026-10-18', body?: unknown, init: RequestInit = {}) {
  return worker.fetch(
    new Request(`https://interpretle.com/api/results/${day}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      ...init,
    }),
    env,
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  for (const db of databases.values()) db.close()
  databases.clear()
  counters.clear()
})

describe('game entry', () => {
  it('redirects HTTP to HTTPS before serving the game, preserving the selected day', async () => {
    const assets = vi.fn(env.ASSETS.fetch)
    for (const path of ['/', '/?day=2026-10-17', '/index.html']) {
      const response = await worker.fetch(
        new Request('http://interpretle.com' + path),
        { ...env, ASSETS: { fetch: assets } },
      )
      expect(response.status).toBe(308)
      expect(response.headers.get('Location')).toBe(
        'https://interpretle.com' + path,
      )
    }
    expect(assets).not.toHaveBeenCalled()
  })

  it('serves the existing static game over HTTPS and in local development', async () => {
    for (const url of [
      'https://interpretle.com/?day=2026-10-17',
      'https://interpretle.com/index.html',
      'http://localhost:8787/',
    ]) {
      const request = new Request(url)
      const assets = vi.fn(env.ASSETS.fetch)
      const response = await worker.fetch(request, {
        ...env,
        ASSETS: { fetch: assets },
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('Static game')
      expect(assets).toHaveBeenCalledWith(request)
    }
  })
})

describe('daily solve counter', () => {
  it('starts empty and isolates each puzzle day', async () => {
    expect(await (await request()).json()).toEqual({
      counts: Array(8).fill(0),
      failed: 0,
    })
    await request('2026-10-18', { id: crypto.randomUUID(), attempts: 4 })
    expect(await (await request()).json()).toEqual({
      counts: [0, 0, 0, 1, 0, 0, 0, 0],
      failed: 0,
    })
    expect(await (await request('2026-10-17')).json()).toEqual({
      counts: Array(8).fill(0),
      failed: 0,
    })
  })

  it('counts concurrent submissions once, including retries after a restart', async () => {
    const results = Array.from({ length: 32 }, (_, i) => ({
      id: crypto.randomUUID(),
      attempts: (i % 8) + 1,
    }))
    await Promise.all(
      [...results, ...results].map((body) => request('2026-10-18', body)),
    )
    expect(await (await request()).json()).toEqual({
      counts: Array(8).fill(4),
      failed: 0,
    })
    counters.clear()
    await request('2026-10-18', { ...results[0], attempts: 8 })
    expect(await (await request()).json()).toEqual({
      counts: Array(8).fill(4),
      failed: 0,
    })
  })

  it('counts exhausted games once and keeps the first result across retries', async () => {
    const lost = { id: crypto.randomUUID(), attempts: 0 }
    const won = { id: crypto.randomUUID(), attempts: 8 }
    await Promise.all(
      [lost, won, lost, won].map((body) => request('2026-10-18', body)),
    )
    counters.clear()
    await request('2026-10-18', { ...lost, attempts: 3 })
    await request('2026-10-18', { ...won, attempts: 0 })
    expect(await (await request()).json()).toEqual({
      counts: [0, 0, 0, 0, 0, 0, 0, 1],
      failed: 1,
    })
  })

  it('rejects invalid results, future puzzles, and cross-site writes', async () => {
    const id = crypto.randomUUID()
    for (const attempts of [-1, 9, 1.5, '4', null])
      expect((await request('2026-10-18', { id, attempts })).status).toBe(400)
    expect(
      (await request('2026-10-18', { id: 'invalid', attempts: 3 })).status,
    ).toBe(400)
    expect((await request('2026-10-18', null)).status).toBe(400)
    expect(
      (await request('2026-10-18', { id, attempts: 3 }, { body: '{' })).status,
    ).toBe(400)
    expect(
      (
        await request(
          '2026-10-18',
          { id, attempts: 3 },
          { body: 'a'.repeat(257) },
        )
      ).status,
    ).toBe(413)
    expect(
      (
        await request(
          '2026-10-18',
          { id, attempts: 3 },
          { headers: { 'Content-Type': 'text/plain' } },
        )
      ).status,
    ).toBe(415)
    expect(
      (
        await request(
          '2026-10-18',
          { id, attempts: 3 },
          {
            headers: {
              Origin: 'https://elsewhere.example',
              'Content-Type': 'application/json',
            },
          },
        )
      ).status,
    ).toBe(403)
    expect(
      (await request('2026-10-18', undefined, { method: 'DELETE' })).status,
    ).toBe(405)
    for (const day of ['2026-10-19', '2026-01-01', 'not-a-day'])
      expect((await request(day)).status).toBe(404)
    expect(await (await request()).json()).toEqual({
      counts: Array(8).fill(0),
      failed: 0,
    })
  })

  it('reports an unavailable counter without inventing results', async () => {
    const response = await worker.fetch(
      new Request('https://interpretle.com/api/results/2026-10-18'),
      {
        ...env,
        RESULTS: {
          getByName() {
            throw new Error('storage unavailable')
          },
        },
      },
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toEqual({
      error: 'Results are temporarily unavailable.',
    })
  })

  it('opens each results bucket at Pacific midnight, including daylight saving time', async () => {
    for (const [previous, today, midnight] of [
      ['2026-10-18', '2026-10-19', '2026-10-19T07:00:00Z'],
      ['2026-12-18', '2026-12-19', '2026-12-19T08:00:00Z'],
    ]) {
      vi.setSystemTime(new Date(Date.parse(midnight) - 1))
      expect((await request(previous)).status).toBe(200)
      expect((await request(today)).status).toBe(404)
      vi.setSystemTime(new Date(midnight))
      expect((await request(today)).status).toBe(200)
    }
  })
})
