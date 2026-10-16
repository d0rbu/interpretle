import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { catalog, feature } from './fixture'
import { choices, createGame } from '../src/lib/game'

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-18T12:00:00Z') })
  await page.route('**/puzzles/index.json', (route) =>
    route.fulfill({ json: catalog }),
  )
  await page.route('**/puzzles/test-feature.json', (route) =>
    route.fulfill({ json: feature }),
  )
  await page.goto('/')
})

test('opens instructions once and shows a compact dated header', async ({
  page,
}) => {
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'interpretle',
  )
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-18',
  )
  await expect(page.locator('header time')).toHaveText('Oct 18, 2026')
  await expect(
    page.getByRole('heading', { name: 'Starting clue' }),
  ).toBeVisible()
  await expect(page.locator('.choices article')).toHaveCount(8)
  await expect(page.getByText('Find the words. Follow the signal')).toHaveCount(
    0,
  )
  await expect(page.getByText('illustrative scores')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Instructions', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('reveals measured token scores and saves each day independently', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const card = choices(
    createGame('daily', '2026-10-18', feature.id),
    feature,
  ).find((p) => p.band === 90)!
  const choice = page
    .locator('.choice')
    .filter({ has: page.getByRole('button', { name: card.text, exact: true }) })
  await choice.locator('summary').click()
  await expect(choice.locator('.context p')).toContainText(
    'Preceding source context.',
  )
  await expect(choice.locator('.context .token')).toHaveCount(0)
  await page.getByRole('button', { name: card.text, exact: true }).click()
  await page.getByRole('button', { name: 'Test passage' }).click()
  await expect(page.locator('.history')).toContainText('90th percentile')
  await page.locator('.history .token').click()
  await expect(page.locator('.history .token-readout')).toContainText('9001.0')
  await page
    .getByRole('combobox', { name: 'Puzzle day' })
    .selectOption('2026-10-16')
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 8')
  await page
    .getByRole('combobox', { name: 'Puzzle day' })
    .selectOption('2026-10-18')
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-18',
  )
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
})

test('keeps practice separate and keeps an archive open across midnight', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await page.locator('.passage-select').first().click()
  await page.getByRole('button', { name: 'Test passage' }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
  await page.getByRole('button', { name: 'Daily', exact: true }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 8')
  await page
    .getByRole('combobox', { name: 'Puzzle day' })
    .selectOption('2026-10-16')
  await page.clock.setSystemTime(new Date('2026-10-19T00:01:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-16',
  )
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-19',
  )
})

test('works without persistent storage and fits the viewport', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
  })
  await page.reload()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.locator('.passage-select').first().click()
  await page.getByRole('button', { name: 'Test passage' }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
  await expect(page.getByText('Browser storage is unavailable.')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})

test('has no serious accessibility violations in instructions or play', async ({
  page,
}) => {
  for (const selector of ['dialog', 'main']) {
    const result = await new AxeBuilder({ page }).include(selector).analyze()
    expect(
      result.violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? ''),
      ),
    ).toEqual([])
    if (selector === 'dialog')
      await page.getByRole('button', { name: 'Play', exact: true }).click()
  }
})

test('wins from measured passages and shares a spoiler-free result', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  let game = createGame('daily', '2026-10-18', feature.id)
  const { playPassage } = await import('../src/lib/game')
  for (const band of [99, 99.9]) {
    const card = choices(game, feature).find((p) => p.band === band)!
    await page.getByRole('button', { name: card.text, exact: true }).click()
    await page.getByRole('button', { name: 'Test passage' }).click()
    game = playPassage(game, feature, card.id)
  }
  await expect(page.getByRole('heading', { name: 'Solved.' })).toBeVisible()
  await expect(page.locator('.reveal')).toContainText(feature.title)
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('unavailable')) },
    }),
  )
  await page.getByRole('button', { name: 'Share result' }).click()
  const result = await page
    .getByRole('textbox', { name: 'Copy your result' })
    .inputValue()
  expect(result).toContain('interpretle 3 · 2/8')
  expect(result).not.toContain(feature.title)
})

test('requires download opt-in and charges only successful custom guesses', async ({
  page,
}) => {
  await page.route('**/puzzles/index.json', (route) =>
    route.fulfill({
      json: {
        ...catalog,
        browserModel: { manifest: '/model/test.json', bytes: 12e9 },
      },
    }),
  )
  await page.addInitScript(() => {
    let submissions = 0
    // Only the worker is replaced here: this exercises the actual UI's async
    // accounting without downloading a GPU model in routine CI.
    class TestWorker {
      onmessage: ((event: { data: object }) => void) | null = null
      onerror = null
      postMessage(message: { type: string; text: string }) {
        queueMicrotask(() => {
          if (message.type === 'prepare')
            this.onmessage?.({ data: { result: null } })
          else if (submissions++ === 0)
            this.onmessage?.({
              data: { error: 'A test inference failure. No attempt was used.' },
            })
          else
            this.onmessage?.({
              data: {
                result: [
                  {
                    id: 42,
                    start: 0,
                    end: message.text.length,
                    activation: 5010,
                  },
                ],
              },
            })
        })
      }
      terminate() {}
    }
    window.Worker = TestWorker as unknown as typeof Worker
  })
  await page.reload()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('button', { name: 'Write your own (2 left)' }).click()
  await page
    .getByLabel('Your sentence', { exact: true })
    .fill('A custom sentence.')
  await expect(
    page.getByRole('button', { name: 'Test sentence' }),
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Download & load local model' })
    .click()
  await page.getByRole('button', { name: 'Test sentence' }).click()
  await expect(page.getByRole('alert')).toContainText('No attempt was used.')
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 8')
  await page
    .getByRole('button', { name: 'Download & load local model' })
    .click()
  await page.getByRole('button', { name: 'Test sentence' }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
  await page.getByRole('button', { name: 'Write your own (1 left)' }).click()
  await page
    .getByLabel('Your sentence', { exact: true })
    .fill('A second custom sentence.')
  await page.getByRole('button', { name: 'Test sentence' }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 3 of 8')
  await expect(
    page.getByRole('button', { name: 'Write your own (0 left)' }),
  ).toBeDisabled()
})
