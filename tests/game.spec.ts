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
  await expect(page.locator('dialog p')).toHaveCount(1)
  expect(
    (await page.locator('dialog p').innerText()).split(/\s+/).length,
  ).toBeLessThan(55)
  await expect(page.getByText('About the model and data')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Data provenance' })).toHaveCount(
    0,
  )
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
  await expect(page.locator('.passage-select')).toHaveCount(7)
  await expect(page.locator('.choices article').last()).toContainText(
    'Write your own',
  )
  await expect(page.locator('.game-status')).toContainText('Best: 0%')
  await expect(page.getByRole('button', { name: 'Test passage' })).toHaveCount(
    0,
  )
  await expect(page.getByText('Goal: 99.9th percentile')).toHaveCount(0)
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

test('expands context inline with only the passage bold and highlighted, and saves each day independently', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const clue = page.locator('.result')
  const clueTokens = await clue.locator('.token').count()
  await clue.getByRole('button', { name: 'Show preceding context' }).click()
  await expect(clue.locator('.heatmap-text')).toHaveText(
    feature.starter.before + feature.starter.text,
  )
  await expect(clue.locator('.heatmap-text strong')).toHaveText(
    feature.starter.text,
  )
  await expect(clue.locator('strong .token')).toHaveCount(clueTokens)
  await expect(clue.locator('.heatmap-text > .token')).toHaveCount(0)
  await clue.getByRole('button', { name: 'Hide preceding context' }).click()
  await expect(clue.locator('.heatmap-text')).toHaveText(feature.starter.text)
  await expect(clue.locator('.heatmap-text strong')).toHaveCount(0)
  await expect(clue.locator('.token')).toHaveCount(clueTokens)

  const cards = choices(createGame('daily', '2026-10-18', feature.id), feature)
  const index = cards.findIndex((p) => p.band === 90)
  const card = cards[index]
  const choice = page.locator('.choice').nth(index)
  await choice.getByRole('button', { name: 'Show preceding context' }).click()
  await expect(choice.locator('.passage-select')).toHaveText(
    card.before + card.text,
  )
  await expect(choice.locator('.passage-select strong')).toHaveText(card.text)
  await expect(choice.locator('.token')).toHaveCount(0)
  await expect(choice.locator('a')).toHaveCount(0)
  await expect(choice).not.toContainText(card.source.title)
  await expect(choice).not.toContainText(card.source.license)
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 8')
  await choice.locator('.passage-select').click()
  await expect(page.locator('.history')).toContainText('90th percentile')
  await expect(page.locator('.history button.token')).toHaveCount(0)
  await expect(page.locator('.history .token[tabindex]')).toHaveCount(0)
  await expect(page.locator('.history .token')).toHaveCSS(
    'background-color',
    /rgba?\(/,
  )
  await page
    .locator('.history')
    .getByRole('button', { name: 'Show preceding context' })
    .click()
  await expect(page.locator('.history .heatmap-text')).toHaveText(
    card.before + card.text,
  )
  await expect(page.locator('.history .heatmap-text strong')).toHaveText(
    card.text,
  )
  await expect(page.locator('.history strong .token')).toHaveCount(1)
  await expect(page.locator('.history .heatmap-text > .token')).toHaveCount(0)
  await expect(page.locator('.history strong .token')).toHaveCSS(
    'background-color',
    /rgba?\(/,
  )
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
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
  await expect(page.getByText('Browser storage is unavailable.')).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})

test('sizes the day selector to its digits and keeps the page aligned between modes', async ({
  page,
}) => {
  await page.route('**/puzzles/index.json', (route) =>
    route.fulfill({
      json: {
        ...catalog,
        daily: {
          ...catalog.daily,
          '2026-10-25': feature.id,
          '2027-01-23': feature.id,
        },
      },
    }),
  )
  await page.clock.setSystemTime(new Date('2027-01-23T12:00:00Z'))
  await page.reload()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const sizes = []
  for (const day of ['2026-10-16', '2026-10-25', '2027-01-23']) {
    await page.getByRole('combobox', { name: 'Puzzle day' }).selectOption(day)
    sizes.push(
      await page.evaluate(() => {
        const picker = document
          .querySelector('.day-picker')!
          .getBoundingClientRect()
        const value = document.querySelector('.day-value')!.firstChild!
        const range = document.createRange()
        range.selectNodeContents(value)
        return {
          width: picker.width,
          padding: picker.width - range.getBoundingClientRect().width,
          dateGap:
            document.querySelector('header time')!.getBoundingClientRect()
              .left - picker.right,
        }
      }),
    )
  }
  expect(sizes[1].width).toBeGreaterThan(sizes[0].width)
  expect(sizes[2].width).toBeGreaterThan(sizes[1].width)
  for (const size of sizes) {
    expect(size.padding).toBeCloseTo(sizes[0].padding, 1)
    expect(size.dateGap).toBeCloseTo(6, 1)
  }
  const alignment = await page.locator('header').boundingBox()
  let game = createGame('daily', '2027-01-23', feature.id)
  const { playPassage } = await import('../src/lib/game')
  for (const band of [99, 99.9]) {
    const card = choices(game, feature).find((p) => p.band === band)!
    await page.getByRole('button', { name: card.text, exact: true }).click()
    game = playPassage(game, feature, card.id)
  }
  await expect(page.getByRole('heading', { name: 'Solved.' })).toBeVisible()
  for (const mode of ['Practice', 'Daily']) {
    await page.getByRole('button', { name: mode, exact: true }).click()
    const position = await page.locator('header').boundingBox()
    expect(position!.x).toBe(alignment!.x)
    expect(position!.width).toBe(alignment!.width)
  }
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
    page.getByRole('button', { name: 'Submit', exact: true }),
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Download & load local model' })
    .click()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('No attempt was used.')
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 8')
  await page
    .getByRole('button', { name: 'Download & load local model' })
    .click()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 8')
  await page.getByRole('button', { name: 'Write your own (1 left)' }).click()
  await page
    .getByLabel('Your sentence', { exact: true })
    .fill('A second custom sentence.')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 3 of 8')
  await expect(
    page.getByRole('button', { name: 'Write your own (0 left)' }),
  ).toBeDisabled()
})
