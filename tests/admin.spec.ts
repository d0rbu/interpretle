import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { dashboardPage } from '../server/dashboard'
import type { Insights } from '../server/insights'
import { profileFixture } from './profile-fixture'

// Synthetic display data only; these requests never reach production analytics.
const sample: Insights = {
  start: '2026-10-05',
  end: '2026-10-18',
  days: 14,
  mode: 'all',
  flowSelection: { day: '2026-10-18', daily: true, practice: false },
  profiles: {
    runtime: 'all',
    expanded: false,
    summary: [
      {
        backend: 'gpu',
        count: 3,
        completed: 2,
        failed: 1,
        cancelled: 0,
        p50Ms: 2000,
        p95Ms: 4000,
      },
    ],
    phases: [
      { kind: 'compute', ms: 700, count: 2 },
      { kind: 'wait', ms: 402, count: 2 },
      { kind: 'weight_read', ms: 300, count: 2 },
      { kind: 'weight_decode', ms: 450, count: 2 },
    ],
    operations: [
      { name: 'Q projection', ms: 250, count: 2 },
      { name: 'Attention', ms: 450, count: 2 },
    ],
    layers: [{ layer: 0, ms: 700, count: 2 }],
    recent: [2000, 4000].map((totalMs, i) => ({
      id: String(i + 1).repeat(64),
      at: `2026-10-18T12:0${i}:00.000Z`,
      player: '11111111-1111-4111-8111-111111111111',
      mode: 'daily',
      round: '2026-10-18',
      feature: 'test',
      browser: 'Firefox 157',
      os: 'macOS',
      backend: 'gpu',
      status: 'ok',
      totalMs,
      tokens: 20,
      run: i + 1,
    })),
    selected: { id: '1'.repeat(64), profile: profileFixture() },
  },
  people: { browsers: 486, returning: 124 },
  series: Array.from({ length: 14 }, (_, i) => ({
    day: `2026-10-${String(i + 5).padStart(2, '0')}`,
    browsers: 16 + i * 5 + (i % 3) * 10,
    returning: i * 2,
    visits: 20 + i * 6,
    games: 11 + i * 4 + (i % 2) * 12,
    wins: 8 + i * 2,
    losses: 2,
    errors: i > 6 ? (i % 4) + 1 : 0,
    guesses: 30 + i * 8,
    writeins: (i % 5) + 1,
    shares: i + 1,
  })),
  flow: [
    [0, 'open', 12],
    [1, 'won', 2],
    [1, 'open', 8],
    [2, 'won', 12],
    [2, 'open', 7],
    [3, 'won', 18],
    [3, 'open', 6],
    [4, 'won', 12],
    [4, 'open', 3],
    [5, 'won', 9],
    [5, 'open', 1],
    [6, 'won', 5],
    [6, 'lost', 5],
  ].map(([guesses, outcome, count]) => ({
    guesses: Number(guesses),
    outcome: outcome as 'open' | 'won' | 'lost',
    count: Number(count),
    limit: 6,
    fromStart: 1,
    bands: Array.from({ length: Number(guesses) }, (_, i) =>
      outcome === 'won' && i === Number(guesses) - 1
        ? 99.9
        : ([0, 50, 90, 95, 99] as const)[i % 5],
    ),
  })),
  attempts: [1, 2, 3, 4, 5, 6].map((n) => ({
    label: String(n),
    count: [2, 12, 18, 12, 9, 5][n - 1],
  })),
  outcomes: [
    { label: 'won', count: 58 },
    { label: 'lost', count: 5 },
  ],
  slots: [
    { label: 'Option 1', count: 48 },
    { label: 'Option 2', count: 79 },
    { label: 'Option 3', count: 44 },
    { label: 'Option 4', count: 56 },
    { label: 'Option 5', count: 67 },
    { label: 'Write-in', count: 31 },
  ],
  themes: [
    { label: 'system / dark', count: 252 },
    { label: 'dark / dark', count: 140 },
    { label: 'system / light', count: 110 },
    { label: 'light / light', count: 50 },
  ],
  devices: [
    { label: 'desktop', count: 320 },
    { label: 'phone', count: 150 },
    { label: 'tablet', count: 10 },
    { label: 'unknown', count: 6 },
  ],
  practice: [
    { label: '0', count: 258 },
    { label: '1', count: 92 },
    { label: '2', count: 61 },
    { label: '3–5', count: 47 },
    { label: '6–10', count: 22 },
    { label: '11+', count: 6 },
  ],
  coverage: {
    historySince: '2026-10-18T12:00:00.000Z',
    errorRecords: 14,
    exceptions: 8,
  },
  issues: [
    {
      issue: 'a'.repeat(64),
      count: 6,
      players: 4,
      firstAt: '2026-10-18T12:00:00.000Z',
      lastAt: '2026-10-18T18:32:41.120Z',
      samples: [
        {
          id: 'b'.repeat(64),
          at: '2026-10-18T18:32:41.120Z',
          player: '11111111-1111-4111-8111-111111111111',
          details: {
            browser: 'Firefox 157.0.1',
            os: 'macOS',
            device: 'desktop',
            backend: 'gpu',
            phase: 'inference',
            code: 'out_of_memory',
            cores: 8,
            mode: 'daily',
            round: '2026-10-18',
            feature: 'gemma4-l21-sae-58-v2',
            report: {
              source: 'model',
              name: 'RuntimeError',
              message: 'Cannot allocate GPU buffer',
              stage: 'Layer 7/22 · Attention',
              release: 'sample-build',
              tokens: 54,
              threads: 1,
              stack:
                'RuntimeError: Cannot allocate GPU buffer\n    at attention (https://interpretle.com/assets/model.worker-example.js:7:42)',
              trail: [
                {
                  at: '2026-10-18T18:32:39.000Z',
                  stage: 'guess_submit · daily · guess 2',
                },
                {
                  at: '2026-10-18T18:32:40.000Z',
                  stage: 'Layer 7/22 · QKV projections',
                },
                {
                  at: '2026-10-18T18:32:41.000Z',
                  stage: 'Layer 7/22 · Attention',
                },
              ],
            },
          },
        },
      ],
    },
  ],
}

test('private dashboard charts and errors remain readable in light and dark modes', async ({
  page,
}, info) => {
  const response = await dashboardPage(Response.json(sample))
  await page.setContent(await response.text())
  await page
    .getByText('Break down each guess by percentile', { exact: true })
    .click()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(
      page.getByRole('heading', { name: 'Game overview' }),
    ).toBeVisible()
    await expect(
      page.getByRole('img', {
        name: 'Game progression by percentile: 100 opened, 58 solved, 37 unfinished, 5 out of attempts',
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('img', {
        name: 'Game progression: 100 opened, 58 solved, 37 unfinished, 5 out of attempts',
      }),
    ).toBeVisible()
    await expect(page.getByLabel('Ending on')).toHaveValue('2026-10-18')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.screenshot({
      path: info.outputPath(`dashboard-${colorScheme}.png`),
      fullPage: true,
    })
    await page.locator('#game-flow').screenshot({
      path: info.outputPath(`flow-${colorScheme}.png`),
    })
  }
  await page
    .getByText('RuntimeError: Cannot allocate GPU buffer', { exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Original exception' }),
  ).toBeVisible()
  await expect(page.locator('pre')).toContainText(
    'model.worker-example.js:7:42',
  )
  await expect(
    page.getByRole('heading', { name: 'Events leading up to the failure' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Open game / browser history ↗' }),
  ).toHaveAttribute('href', /\/admin\/raw\?browser=.*mode=daily/)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: info.outputPath('dashboard-error.png'),
    fullPage: true,
  })
  await expect(
    page.getByRole('img', { name: 'Forward-pass duration over time' }),
  ).toBeVisible()
  await page
    .locator('summary')
    .filter({ hasText: 'Compare operations and layers' })
    .click()
  await page
    .locator('summary')
    .filter({ hasText: 'Forward-pass trace' })
    .click()
  await expect(
    page.getByRole('cell', { name: 'Layer 1 · Attention', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('cell', {
      name: 'Layer 1 · Read & prepare weights',
      exact: false,
    }),
  ).toContainText('FP4 expansion')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('private dashboard makes missing historical paths and empty reports explicit', async ({
  page,
}) => {
  const empty: Insights = {
    ...sample,
    flow: [],
    issues: [],
    devices: [],
    profiles: { ...sample.profiles, summary: [], recent: [], selected: null },
    coverage: { historySince: null, errorRecords: 0, exceptions: 0 },
    series: sample.series.map((row) => ({ ...row, errors: 0 })),
  }
  await page.setContent(
    await (await dashboardPage(Response.json(empty))).text(),
  )
  await expect(
    page.getByText('Older aggregate counters cannot reconstruct these paths.', {
      exact: false,
    }),
  ).toBeVisible()
  await expect(
    page.getByText('No errors recorded in this window.'),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Raw data ↗' })).toHaveAttribute(
    'href',
    '/admin/raw?day=2026-10-18',
  )
})

test('Sankey filters update in place with Daily selected by default and persist across dashboard filters', async ({
  page,
}) => {
  await page.route('**/admin?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    const custom = params.has('flowDay')
    const flowSelection = {
      day: params.get('flowDay') ?? sample.end,
      daily: !custom || params.has('flowDaily'),
      practice: custom && params.has('flowPractice'),
    }
    const response = await dashboardPage(
      Response.json({
        ...sample,
        days: Number(params.get('days') ?? sample.days),
        mode: params.get('game') ?? sample.mode,
        profiles: {
          ...sample.profiles,
          runtime: params.get('runtime') ?? sample.profiles.runtime,
        },
        flowSelection,
        flow: flowSelection.daily || flowSelection.practice ? sample.flow : [],
      }),
    )
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    })
  })
  await page.goto('/admin?day=2026-10-18&days=14&game=all&runtime=gpu')
  await page.locator('.metrics').evaluate((element) => {
    element.setAttribute('data-preserved', 'true')
  })
  await page.locator('.flow-detail summary').click()
  const filters = page.getByRole('form', { name: 'Game progression filters' })
  const daily = filters.getByRole('button', {
    name: 'Daily games',
    exact: true,
  })
  const practice = filters.getByRole('button', {
    name: 'Practice games',
    exact: true,
  })
  await expect(daily).toHaveAttribute('aria-pressed', 'true')
  await expect(practice).toHaveAttribute('aria-pressed', 'false')
  await expect(filters.getByRole('button', { name: 'Apply' })).toHaveCount(0)
  await filters.getByLabel('Pacific date').fill('2026-10-17')
  await expect(page).toHaveURL(/flowDay=2026-10-17&flowDaily=1#game-flow$/)
  await practice.click()
  await expect(page).toHaveURL(
    /flowDay=2026-10-17&flowDaily=1&flowPractice=1#game-flow$/,
  )
  await daily.click()
  await expect(page).toHaveURL(/flowDay=2026-10-17&flowPractice=1#game-flow$/)
  expect(new URL(page.url()).searchParams.get('game')).toBe('all')
  expect(new URL(page.url()).searchParams.get('days')).toBe('14')
  expect(new URL(page.url()).searchParams.get('runtime')).toBe('gpu')
  await expect(daily).toHaveAttribute('aria-pressed', 'false')
  await expect(practice).toHaveAttribute('aria-pressed', 'true')
  await expect(filters.getByLabel('Pacific date')).toHaveValue('2026-10-17')
  await expect(page.locator('.metrics')).toHaveAttribute(
    'data-preserved',
    'true',
  )
  await expect(page.locator('.flow-detail')).toHaveAttribute('open', '')

  await practice.click()
  await expect(page).toHaveURL(/flowDay=2026-10-17#game-flow$/)
  await expect(page.locator('#game-flow')).toContainText(
    'Select Daily games, Practice games, or both.',
  )
  await expect(page.locator('#game-flow svg')).toHaveCount(0)
  await daily.click()
  await expect(page).toHaveURL(/flowDay=2026-10-17&flowDaily=1#game-flow$/)
  await expect(daily).toHaveAttribute('aria-pressed', 'true')
  await expect(practice).toHaveAttribute('aria-pressed', 'false')

  await page
    .getByRole('combobox', { name: 'Window', exact: true })
    .selectOption('7')
  await page
    .locator('.page-heading')
    .getByRole('button', { name: 'Apply' })
    .click()
  await expect(page).toHaveURL(/flowDay=2026-10-17&flowDaily=1/)
  await expect(filters.getByLabel('Pacific date')).toHaveValue('2026-10-17')
  await expect(daily).toHaveAttribute('aria-pressed', 'true')
  await expect(practice).toHaveAttribute('aria-pressed', 'false')
})
