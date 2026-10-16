import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { choices, createGame, storageKey } from '../src/lib/game'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-16T12:00:00Z'))
  await page.goto('/')
})

test('free clue, hidden options, context, heatmaps, and saved progress', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(
    page.getByRole('heading', { name: 'What else might light it up?' }),
  ).toBeVisible()
  await expect(page.getByText('Attempt 1 of 8', { exact: true })).toBeVisible()
  await expect(page.locator('.starter-panel')).toContainText('Max 50th')
  await expect(page.locator('.passage-card')).toHaveCount(8)
  await expect(page.locator('.passage-card')).not.toContainText(['percentile'])
  await expect(
    page.getByRole('button', { name: 'Test passage', exact: true }),
  ).toBeDisabled()

  await page.locator('.passage-context summary').first().click()
  await expect(page.locator('.passage-context[open]')).toContainText(
    'Original demo passage',
  )
  await expect(page.getByText('Attempt 1 of 8', { exact: true })).toBeVisible()
  await page.locator('.passage-context summary').first().click()
  await page.screenshot({
    path: testInfo.outputPath('opening.png'),
    fullPage: true,
  })

  const game = createGame('daily', '2026-10-16')
  const passage = choices(game).find((p) => p.band === 90)!
  await page
    .locator('.passage-select')
    .filter({ hasText: passage.text })
    .click()
  await page.getByRole('button', { name: 'Test passage', exact: true }).click()
  await expect(page.getByText('Attempt 2 of 8', { exact: true })).toBeVisible()
  await expect(page.locator('.guess-history > li')).toHaveCount(1)
  await expect(page.locator('.guess-history')).toContainText('90th')
  await expect(page.locator('.guess-history .token')).not.toHaveCount(0)
  await page.locator('.guess-history .token').first().click()
  await expect(page.locator('.token-readout')).toContainText('Demo activation')
  await page.reload()
  await expect(page.getByText('Attempt 2 of 8', { exact: true })).toBeVisible()
  await expect(page.locator('.guess-history')).toContainText('90th')
  await expect(page.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '90',
  )
  expect(errors).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath('after-guess.png'),
    fullPage: true,
  })
})

test('two custom sentences, separate practice progress, and the help dialog', async ({
  page,
}) => {
  for (const text of [
    'A red bicycle by the wall.',
    'The blue table is clean.',
  ]) {
    await page.getByRole('button', { name: /Write your own/ }).click()
    await page.getByLabel('Test your theory.').fill(text)
    await page
      .getByRole('button', { name: 'Test sentence', exact: true })
      .click()
  }
  await expect(page.getByText('Attempt 3 of 8', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Write your own/ }),
  ).toBeDisabled()
  await page.reload()
  await expect(
    page.getByRole('button', { name: /Write your own/ }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await expect(page.getByText('Attempt 1 of 8', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Write your own/ }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Daily', exact: true }).click()
  await expect(page.getByText('Attempt 3 of 8', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'How to play' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('eight attempts')
  await page.getByRole('button', { name: 'Let’s play' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a winning game reveals the feature and offers a spoiler-free share', async ({
  page,
}, testInfo) => {
  let game = createGame('daily', '2026-10-16')
  const { playPassage } = await import('../src/lib/game')
  for (const band of [99, 99.9]) {
    const passage = choices(game).find((p) => p.band === band)!
    await page
      .locator('.passage-select')
      .filter({ hasText: passage.text })
      .click()
    await page
      .getByRole('button', { name: 'Test passage', exact: true })
      .click()
    game = playPassage(game, passage.id)
  }
  await expect(
    page.getByRole('heading', { name: 'You found the signal.' }),
  ).toBeVisible()
  await expect(page.locator('.feature-reveal')).toContainText(
    'not an identified Gemma feature',
  )
  await expect(page.locator('.passage-card')).toHaveCount(0)
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    }),
  )
  await page.getByRole('button', { name: 'Share result' }).click()
  await expect(page.getByLabel('Copy your spoiler-free result')).toHaveValue(
    /2\/8/,
  )
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'You found the signal.' }),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('win.png'),
    fullPage: true,
  })
})

test('remains playable with unavailable storage and no horizontal overflow', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error('Storage unavailable')
    }
    Storage.prototype.getItem = () => {
      throw new Error('Storage unavailable')
    }
  })
  await page.reload()
  await expect(page.getByText(/Browser storage is unavailable/)).toBeVisible()
  await page.locator('.passage-select').first().click()
  await page.getByRole('button', { name: 'Test passage', exact: true }).click()
  await expect(page.getByText('Attempt 2 of 8', { exact: true })).toBeVisible()
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )
  expect(noOverflow).toBe(true)
})

test('does not carry yesterday’s attempts into a new UTC puzzle', async ({
  page,
}) => {
  await page.locator('.passage-select').first().click()
  await page.getByRole('button', { name: 'Test passage', exact: true }).click()
  await expect(page.getByText('Attempt 2 of 8', { exact: true })).toBeVisible()
  await page.clock.setFixedTime(new Date('2026-10-17T00:00:01Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('Daily puzzle · Oct 17')).toBeVisible()
  await expect(page.getByText('Attempt 1 of 8', { exact: true })).toBeVisible()
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    storageKey('daily', '2026-10-16'),
  )
  expect(saved.moves).toHaveLength(1)
})

test('has no serious or critical automated accessibility violations', async ({
  page,
}) => {
  const initial = await new AxeBuilder({ page }).analyze()
  expect(
    initial.violations
      .filter((issue) => ['serious', 'critical'].includes(issue.impact ?? ''))
      .map((issue) => ({
        id: issue.id,
        targets: issue.nodes.map((node) => node.target),
      })),
  ).toEqual([])
  await page.getByRole('button', { name: 'How to play' }).click()
  const dialog = await new AxeBuilder({ page })
    .include('.help-dialog')
    .analyze()
  expect(
    dialog.violations
      .filter((issue) => ['serious', 'critical'].includes(issue.impact ?? ''))
      .map((issue) => ({
        id: issue.id,
        targets: issue.nodes.map((node) => node.target),
      })),
  ).toEqual([])
})
