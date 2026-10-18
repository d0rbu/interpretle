import { afterEach, expect, it, vi } from 'vitest'
import { ForwardProfile, validProfile } from './model-profile'
import { profileFixture } from '../../tests/profile-fixture'

afterEach(() => vi.restoreAllMocks())

it('records overlapping work, elapsed time and partial failure without adding the spans together', async () => {
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const p = new ForwardProfile({
    backend: 'gpu',
    threads: 1,
    manifest: '/test.json',
    run: 2,
  })
  p.tokens = 21
  const start = now
  now += 20
  await p.measure(
    'compute',
    'Attention',
    () => {
      now += 30
    },
    0,
  )
  now += 10
  p.record('weights', 'Read & prepare weights', start, 1, {
    readMs: 40,
    decodeMs: 20,
    bytes: 10,
  })
  await expect(
    p.measure(
      'compute',
      'MLP',
      () => {
        now += 5
        throw new Error('broken')
      },
      0,
    ),
  ).rejects.toThrow('broken')
  const result = p.snapshot('error')
  expect(result).toMatchObject({
    totalMs: 65,
    tokens: 21,
    run: 2,
    status: 'error',
  })
  expect(result.steps).toEqual([
    {
      kind: 'weights',
      name: 'Read & prepare weights',
      startMs: 0,
      ms: 60,
      layer: 1,
      readMs: 40,
      decodeMs: 20,
      bytes: 10,
    },
    { kind: 'compute', name: 'Attention', startMs: 20, ms: 30, layer: 0 },
    {
      kind: 'compute',
      name: 'MLP',
      startMs: 60,
      ms: 5,
      layer: 0,
      failed: true,
    },
  ])
  expect(validProfile(result)).toBe(true)
})

it('rejects unbounded, malformed, unfinished or implausible profiles', () => {
  expect(validProfile(profileFixture())).toBe(true)
  for (const value of [
    null,
    [],
    { ...profileFixture(), extra: 'not allowed' },
    profileFixture({ status: 'running' }),
    profileFixture({ totalMs: Infinity }),
    profileFixture({ totalMs: -1 }),
    profileFixture({ run: 0 }),
    profileFixture({ startedAt: 'not a timestamp' }),
    profileFixture({ steps: Array(513).fill(profileFixture().steps[0]) }),
    profileFixture({
      steps: [{ kind: 'compute', name: 'x', startMs: 1999, ms: 10 }],
    }),
    profileFixture({
      steps: [{ kind: 'compute', name: 'x', startMs: 0, ms: 10, readMs: NaN }],
    }),
  ])
    expect(validProfile(value)).toBe(false)
})
