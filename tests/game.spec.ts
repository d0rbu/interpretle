import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { catalog, feature } from './fixture'
import { choices, createGame } from '../src/lib/game'

test.beforeEach(async ({ page }) => {
  const reported = new Set<string>()
  const counts = Array<number>(8).fill(0)
  let failed = 0
  await page.route('**/api/results/**', (route) => {
    if (route.request().method() === 'POST') {
      const { id, attempts } = route.request().postDataJSON()
      if (!reported.has(id)) {
        reported.add(id)
        if (attempts === 0) failed++
        else counts[attempts - 1]++
      }
    }
    return route.fulfill({ json: { counts, failed } })
  })
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
    page.locator('header').getByRole('link', { name: 'Henry', exact: true }),
  ).toHaveAttribute('href', 'https://x.com/henrycstllo')
  await expect(
    page.getByRole('heading', { name: 'Starting clue' }),
  ).toBeVisible()
  await expect(page.locator('.choices article')).toHaveCount(6)
  await expect(page.locator('.passage-select')).toHaveCount(5)
  await expect(
    page.locator('.choices article').last().getByRole('textbox'),
  ).toHaveAttribute('placeholder', 'Write your own (2 left)')
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

test('shows a skeleton while loading and opens a preloaded practice puzzle immediately', async ({
  page,
}) => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/puzzles/test-feature.json', async (route) => {
    await waiting
    await route.fulfill({ json: feature })
  })
  await page.route('**/puzzles/index.json', (route) =>
    route.fulfill({
      json: { ...catalog, practice: ['test-practice'] },
    }),
  )
  await page.route('**/puzzles/test-practice.json', (route) =>
    route.fulfill({
      json: { ...feature, id: 'test-practice' },
    }),
  )
  const practiceLoaded = page.waitForResponse('**/puzzles/test-practice.json')
  await page.reload()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(
    page.getByRole('status', { name: 'Loading puzzle' }),
  ).toBeVisible()
  await expect(page.locator('.puzzle-skeleton .choice')).toHaveCount(6)
  await expect(page.getByText('Loading puzzle…', { exact: true })).toHaveCount(
    0,
  )
  release()
  await expect(
    page.getByRole('heading', { name: 'Starting clue' }),
  ).toBeVisible()
  await practiceLoaded
  // A cached feature is used on the first render, without a skeleton flash.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('.puzzle-skeleton'))
        (window as unknown as { loadingFlash: boolean }).loadingFlash = true
    })
    observer.observe(document.getElementById('puzzle')!, {
      childList: true,
      subtree: true,
    })
  })
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'New puzzle', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as unknown as { loadingFlash?: boolean }).loadingFlash,
    ),
  ).not.toBe(true)
})

test('keeps highlights compact and the moving tokens attached to their card while scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ ...page.viewportSize()!, height: 500 })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const clue = page.locator('.result')
  const sizes = await clue.locator('.token').evaluateAll((tokens) =>
    tokens.map((token) => ({
      height: token.getBoundingClientRect().height,
      font: parseFloat(getComputedStyle(token).fontSize),
    })),
  )
  expect(sizes.every(({ height, font }) => height < font * 1.6)).toBe(true)
  expect(await clue.locator('.token-space').count()).toBeGreaterThan(0)
  expect(new Set(sizes.map(({ height }) => height)).size).toBe(1)
  // Context must animate in browsers without either view-transition API.
  await clue.evaluate((element) => {
    Object.defineProperty(element, 'startViewTransition', { value: undefined })
    Object.defineProperty(document, 'startViewTransition', { value: undefined })
  })
  await clue.getByRole('button', { name: 'Show preceding context' }).click()
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .some((animation) =>
        (animation.effect as KeyframeEffect | null)?.target?.matches(
          '.passage-piece',
        ),
      ),
  )
  await page.evaluate(() =>
    document.getAnimations().forEach((animation) => {
      animation.pause()
      animation.currentTime = 275
    }),
  )
  expect(
    await clue.locator('.passage-piece').evaluateAll((pieces) =>
      pieces.every((piece) => {
        const weight = parseFloat(getComputedStyle(piece).fontWeight)
        return weight > 400 && weight < 700
      }),
    ),
  ).toBe(true)
  // Keep the chevron's hover state fixed when it moves beneath the cursor.
  await page.mouse.move(0, 0)
  const before = await clue.screenshot({ animations: 'allow' })
  const initialTop = (await clue.boundingBox())!.y
  await page.evaluate(() => window.scrollBy(0, 50))
  await expect
    .poll(async () => (await clue.boundingBox())!.y)
    .toBeCloseTo(initialTop - 50, 0)
  const after = await clue.screenshot({ animations: 'allow' })
  if (!after.equals(before)) {
    await test
      .info()
      .attach('before-scroll', { body: before, contentType: 'image/png' })
    await test
      .info()
      .attach('after-scroll', { body: after, contentType: 'image/png' })
  }
  expect(after.equals(before)).toBe(true)
  await page.evaluate(() =>
    document.getAnimations().forEach((animation) => animation.finish()),
  )
  await expect(clue.locator('strong')).toHaveText(feature.starter.text)
  await expect(clue).not.toHaveClass(/context-motion/)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await clue.getByRole('button', { name: 'Hide preceding context' }).click()
  await expect(clue.locator('strong')).toHaveCount(0)
  expect(
    await clue.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0)
})

test('moves highlighted spaces continuously during expansion and collapse', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const clue = page.locator('.result')
  const positions = () =>
    clue.locator('.token-space').evaluateAll((spaces) =>
      spaces.map((space) => {
        const root = space.closest('.result')!.getBoundingClientRect()
        const rect = space.getBoundingClientRect()
        return { x: rect.x - root.x, y: rect.y - root.y }
      }),
    )
  const pauseAt = (time: number) =>
    page.evaluate((time) => {
      document.getAnimations().forEach((animation) => {
        animation.pause()
        animation.currentTime = time
      })
    }, time)
  for (const expanded of [true, false]) {
    const start = await positions()
    expect(start.length).toBeGreaterThan(0)
    await clue
      .getByRole('button', {
        name: expanded ? 'Show preceding context' : 'Hide preceding context',
      })
      .click()
    await pauseAt(0)
    ;(await positions()).forEach((space, i) => {
      expect(space.x).toBeCloseTo(start[i].x, 1)
      expect(space.y).toBeCloseTo(start[i].y, 1)
    })
    await pauseAt(275)
    const middle = await positions()
    await page.evaluate(() =>
      document.getAnimations().forEach((animation) => animation.finish()),
    )
    await expect(clue).not.toHaveClass(/context-motion/)
    const end = await positions()
    let moved = 0
    end.forEach((space, i) => {
      const distance = Math.hypot(space.x - start[i].x, space.y - start[i].y)
      if (distance < 10) return
      moved++
      expect(
        Math.hypot(middle[i].x - start[i].x, middle[i].y - start[i].y),
      ).toBeGreaterThan(1)
      expect(
        Math.hypot(middle[i].x - space.x, middle[i].y - space.y),
      ).toBeGreaterThan(1)
    })
    expect(moved).toBeGreaterThan(0)
  }
})

test('collapses bold context without splitting tokens or jumping at the first frame', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  for (const card of [
    page.locator('.result'),
    page.locator('.choices .choice').first(),
  ]) {
    await card.getByRole('button', { name: 'Show preceding context' }).click()
    await expect(card).not.toHaveClass(/context-motion/)
    const expanded = await card.locator('[data-flow]').evaluateAll((pieces) =>
      pieces.map((piece) => {
        const root = piece.closest('.choice, .result')!.getBoundingClientRect()
        const rect = piece.getBoundingClientRect()
        return { x: rect.x - root.x, y: rect.y - root.y }
      }),
    )
    await card.getByRole('button', { name: 'Hide preceding context' }).click()
    for (const time of [0, 200, 400]) {
      await page.evaluate((time) => {
        document.getAnimations().forEach((animation) => {
          animation.pause()
          animation.currentTime = time
        })
      }, time)
      const frame = await card.locator('[data-flow]').evaluateAll((pieces) =>
        pieces.map((piece) => {
          const root = piece
            .closest('.choice, .result')!
            .getBoundingClientRect()
          const rect = piece.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(piece.firstElementChild ?? piece)
          return {
            x: rect.x - root.x,
            y: rect.y - root.y,
            lines: range.getClientRects().length,
          }
        }),
      )
      expect(frame.every((piece) => piece.lines === 1)).toBe(true)
      if (time === 0)
        frame.forEach((piece, i) => {
          expect(piece.x).toBeCloseTo(expanded[i].x, 1)
          expect(piece.y).toBeCloseTo(expanded[i].y, 1)
        })
    }
    await page.evaluate(() =>
      document.getAnimations().forEach((animation) => animation.finish()),
    )
    await expect(card).not.toHaveClass(/context-motion/)
    await expect(card.locator('strong')).toHaveCount(0)
  }
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
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await choice.locator('.passage-select').click()
  await expect(page.locator('.history')).toContainText('90th percentile')
  await expect(page.locator('.history button.token')).toHaveCount(0)
  await expect(page.locator('.history .token[tabindex]')).toHaveCount(0)
  await expect(page.locator('.history .token').first()).toHaveCSS(
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
  expect(
    (await page.locator('.history strong .token').allTextContents()).join(''),
  ).toBe(card.text)
  await expect(page.locator('.history .heatmap-text > .token')).toHaveCount(0)
  await expect(page.locator('.history strong .token').first()).toHaveCSS(
    'background-color',
    /rgba?\(/,
  )
  await page
    .getByRole('combobox', { name: 'Puzzle day' })
    .selectOption('2026-10-16')
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await page
    .getByRole('combobox', { name: 'Puzzle day' })
    .selectOption('2026-10-18')
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-18',
  )
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
})

test('keeps practice separate and keeps an archive open across Pacific midnight', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await page.locator('.passage-select').first().click()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
  await page.getByRole('button', { name: 'Daily', exact: true }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await page
    .getByRole('combobox', { name: 'Puzzle day' })
    .selectOption('2026-10-16')
  await page.clock.setSystemTime(new Date('2026-10-19T07:01:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-16',
  )
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Puzzle day' })).toHaveValue(
    '2026-10-19',
  )
})

test('rolls the current daily puzzle at Pacific midnight rather than UTC midnight', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.locator('.passage-select').first().click()
  await page.clock.setSystemTime(new Date('2026-10-19T00:01:00Z'))
  await page.reload()
  const day = page.getByRole('combobox', { name: 'Puzzle day' })
  await expect(day).toHaveValue('2026-10-18')
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
  await expect(day.locator('option[value="2026-10-19"]')).toHaveCount(0)
  await page.clock.setSystemTime(new Date('2026-10-19T06:59:59Z'))
  await page.clock.runFor(16000)
  await expect(day).toHaveValue('2026-10-19')
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await day.selectOption('2026-10-18')
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
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
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
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
  for (const band of [90, 99.9]) {
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

test('celebrates a solve, shows daily counts and optional details, and confirms copying', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  let game = createGame('daily', '2026-10-18', feature.id)
  const { playPassage } = await import('../src/lib/game')
  for (const band of [90, 99.9]) {
    const card = choices(game, feature).find((p) => p.band === band)!
    await page.getByRole('button', { name: card.text, exact: true }).click()
    game = playPassage(game, feature, card.id)
  }
  await expect(page.getByRole('heading', { name: 'Solved.' })).toBeVisible()
  await expect(page.locator('.reveal')).toContainText(feature.title)
  await expect(page.locator('.celebration span')).toHaveCount(36)
  await expect(page.locator('.history .guess-color').last()).toHaveText('✨')
  await expect(page.locator('.guess-color').first()).toHaveCSS('width', '22px')
  await expect(page.locator('.guess-color').first()).toHaveCSS(
    'border-radius',
    '5px',
  )
  await expect(page.locator('.distribution li')).toHaveCount(7)
  await expect(page.locator('.distribution .your-result')).toHaveAttribute(
    'aria-label',
    '2 guesses: 1 solve, your result',
  )
  await expect(
    page.getByRole('link', { name: 'Gemma 4 E4B', exact: true }),
  ).not.toBeVisible()
  await page.getByText('Concept details', { exact: true }).click()
  await expect(
    page.getByRole('link', { name: 'Gemma 4 E4B', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Open in Neuronpedia' }),
  ).toHaveAttribute(
    'href',
    'https://www.neuronpedia.org/gemma-4-e4b/21-matryoshka-res-65k/42',
  )
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    }),
  )
  await page.getByRole('button', { name: 'Share result' }).click()
  await expect(
    page.getByRole('button', { name: 'Copied to clipboard' }),
  ).toHaveCSS('background-color', 'rgb(222, 237, 216)')
  await page.clock.fastForward(3100)
  await expect(page.getByRole('button', { name: 'Share result' })).toBeVisible()
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('unavailable')) },
    }),
  )
  await page.getByRole('button', { name: 'Share result' }).click()
  const result = await page
    .getByRole('textbox', { name: 'Copy your result' })
    .inputValue()
  expect(result).toContain('interpretle 3 · 2/6')
  expect(result).toContain('🟧✨')
  expect(result).not.toContain(feature.title)
  await page.reload()
  await expect(page.locator('.distribution .your-result')).toHaveAttribute(
    'aria-label',
    '2 guesses: 1 solve, your result',
  )
  await expect(page.locator('.celebration')).toHaveCount(0)
  const accessibility = await new AxeBuilder({ page })
    .include('.reveal')
    .analyze()
  expect(
    accessibility.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    ),
  ).toEqual([])
})

test('prefetches without blocking play, joins on focus, and charges only successful write-ins', async ({
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
    let pending: TestWorker | undefined
    const modelTest = {
      messages: [] as string[],
      ready() {
        pending?.onmessage?.({ data: { result: null } })
        pending = undefined
      },
    }
    Object.assign(window, { modelTest })
    // Only the worker is replaced here: this exercises the actual UI's async
    // accounting without downloading a GPU model in routine CI.
    class TestWorker {
      onmessage: ((event: { data: object }) => void) | null = null
      onerror = null
      postMessage(message: { type: string; text: string }) {
        modelTest.messages.push(message.type)
        if (message.type === 'prepare') {
          pending = this
          this.onmessage?.({
            data: { progress: 'Downloading model…', fraction: 0.25 },
          })
          return
        }
        queueMicrotask(() => {
          if (submissions++ === 0)
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
  const messages = () =>
    page.evaluate(
      () =>
        (window as unknown as { modelTest: { messages: string[] } }).modelTest
          .messages,
    )
  const ready = () =>
    page.evaluate(() =>
      (window as unknown as { modelTest: { ready(): void } }).modelTest.ready(),
    )
  const input = page.getByRole('textbox', {
    name: 'Your sentence',
    exact: true,
  })
  await expect.poll(messages).toEqual(['prepare'])
  await expect(page.locator('.passage-select').first()).toBeEnabled()
  await page.getByRole('button', { name: 'Practice', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New puzzle' })).toBeEnabled()
  await page.getByRole('button', { name: 'Daily', exact: true }).click()
  await expect(page.locator('.passage-select').first()).toBeEnabled()
  expect(await messages()).toEqual(['prepare'])
  await expect(page.locator('.write-in button')).toHaveCount(0)
  await expect(page.locator('.character-count')).toHaveCount(0)
  await expect(page.getByText('Scored locally with WebGPU')).toHaveCount(0)
  await input.focus()
  await expect(page.locator('.character-count')).toHaveText('0/280')
  await expect.poll(messages).toEqual(['prepare'])
  await expect(page.locator('.write-in progress')).toHaveAttribute(
    'value',
    '0.25',
  )
  await expect(
    page.getByText('Downloading model…', { exact: true }),
  ).toHaveCount(0)
  const card = page.locator('.write-in')
  const cardHeight = (await card.boundingBox())!.height
  const inputHeight = (await input.boundingBox())!.height
  await page
    .locator('.write-in')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.write-in progress')).toHaveCount(0)
  await input.focus()
  await expect.poll(messages).toEqual(['prepare', 'prepare'])
  await input.press('Enter')
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await input.fill('😀'.repeat(281))
  await expect(page.locator('.character-count')).toHaveText('280/280')
  expect(Array.from(await input.inputValue())).toHaveLength(280)
  await input.fill('A custom sentence.')
  await expect(page.locator('.character-count')).toHaveText('18/280')
  await input.blur()
  await input.focus()
  expect(await messages()).toEqual(['prepare', 'prepare'])
  await input.press('Enter')
  await expect(input).toHaveAttribute('readonly', '')
  expect(await messages()).toEqual(['prepare', 'prepare'])
  await ready()
  await expect(page.locator('.write-in').getByRole('alert')).toContainText(
    'No attempt was used.',
  )
  expect((await card.boundingBox())!.height).toBe(cardHeight)
  expect((await input.boundingBox())!.height).toBeLessThan(inputHeight)
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await expect(input).toHaveAttribute('placeholder', 'Write your own (2 left)')
  await input.press('Enter')
  await expect
    .poll(messages)
    .toEqual(['prepare', 'prepare', 'score', 'prepare'])
  await ready()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
  await expect(page.locator('.character-count')).toHaveText('0/280')
  await expect(input).toHaveAttribute('placeholder', 'Write your own (1 left)')
  await input.fill('A second')
  await input.press('End')
  await input.press('Shift+Enter')
  await input.pressSequentially('custom sentence.')
  await expect(input).toHaveValue('A second\ncustom sentence.')
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    bubbles: true,
  })
  expect(await messages()).toEqual([
    'prepare',
    'prepare',
    'score',
    'prepare',
    'score',
  ])
  await input.press('Enter')
  await expect(page.locator('.game-status')).toContainText('Attempt 3 of 6')
  await expect(input).toBeDisabled()
  await expect(input).toHaveAttribute('placeholder', 'Write your own (0 left)')
})

test('shows the worker failure reason without growing the card or losing a draft', async ({
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
    window.Worker = class {
      onmessage: ((event: { data: object }) => void) | null = null
      onerror: ((event: { message: string }) => void) | null = null
      postMessage() {
        this.onmessage?.({ data: { progress: 'Loading model…' } })
        Object.assign(window, {
          failModel: () =>
            this.onerror?.({
              message:
                'Failed to fetch dynamically imported module: https://cdn.example/model-runtime.js?diagnostic=' +
                'long-runtime-detail-'.repeat(30),
            }),
        })
      }
      terminate() {}
    } as unknown as typeof Worker
  })
  await page.reload()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const input = page.getByRole('textbox', {
    name: 'Your sentence',
    exact: true,
  })
  const card = page.locator('.write-in')
  await input.fill('Keep my draft.')
  const before = (await card.boundingBox())!
  const inputHeight = (await input.boundingBox())!.height
  await page.evaluate(() =>
    (window as unknown as { failModel(): void }).failModel(),
  )
  const alert = card.getByRole('alert')
  await expect(alert).toContainText('Model worker failed: Failed to fetch')
  await expect(alert).toContainText('Check your connection or content blocker')
  await expect(input).toHaveValue('Keep my draft.')
  await expect(input).toHaveAttribute('placeholder', 'Write your own (2 left)')
  await expect(input).toHaveAttribute('aria-describedby', /custom-error/)
  await expect(page.locator('.game-status')).toContainText('Attempt 1 of 6')
  await expect(page.getByRole('alert')).toHaveCount(1)
  expect((await card.boundingBox())!.height).toBe(before.height)
  expect((await input.boundingBox())!.height).toBeLessThan(inputHeight)
  const errorBox = (await alert.boundingBox())!
  const counter = (await card.locator('.character-count').boundingBox())!
  expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(counter.y)
  expect(counter.y + counter.height).toBeLessThan(before.y + before.height)
  expect(await alert.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  )
})

test('keeps failed background loading silent and reuses a successful retry', async ({
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
    const messages: string[] = []
    Object.assign(window, { modelMessages: messages })
    window.Worker = class {
      onmessage: ((event: { data: object }) => void) | null = null
      postMessage(message: { type: string }) {
        messages.push(message.type)
        this.onmessage?.({
          data:
            messages.length === 1
              ? { error: 'A test download failure.' }
              : { result: null },
        })
      }
      terminate() {}
    } as unknown as typeof Worker
  })
  await page.reload()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const messages = () =>
    page.evaluate(
      () => (window as unknown as { modelMessages: string[] }).modelMessages,
    )
  await expect.poll(messages).toEqual(['prepare'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  const inactive = choices(
    createGame('daily', '2026-10-18', feature.id),
    feature,
  ).find((passage) => passage.band === 0)!
  await page.getByRole('button', { name: inactive.text, exact: true }).click()
  await expect(page.locator('.game-status')).toContainText('Attempt 2 of 6')
  expect(await messages()).toEqual(['prepare'])
  const input = page.getByRole('textbox', {
    name: 'Your sentence',
    exact: true,
  })
  await input.focus()
  await expect.poll(messages).toEqual(['prepare', 'prepare'])
  await expect(page.locator('.write-in progress')).toHaveCount(0)
  await input.blur()
  await input.focus()
  expect(await messages()).toEqual(['prepare', 'prepare'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(input).toHaveAttribute('placeholder', 'Write your own (2 left)')
})

test('records a failed daily game in the X bar without counting a reload twice', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  let game = createGame('daily', '2026-10-18', feature.id)
  const { playPassage } = await import('../src/lib/game')
  for (let attempt = 0; attempt < 6; attempt++) {
    const card = choices(game, feature).find((p) => p.band === 0)!
    await page.getByRole('button', { name: card.text, exact: true }).click()
    game = playPassage(game, feature, card.id)
  }
  await expect(
    page.getByRole('heading', { name: 'Out of attempts.' }),
  ).toBeVisible()
  await expect(page.locator('.distribution li')).toHaveCount(7)
  await expect(
    page.locator('.distribution li').last().locator('span').first(),
  ).toHaveText('X')
  await expect(page.locator('.distribution .your-result')).toHaveAttribute(
    'aria-label',
    'Failed: 1 player, your result',
  )
  await expect(page.locator('.distribution-heading')).toContainText('0 solved')
  await page.reload()
  await expect(page.locator('.distribution .your-result')).toHaveAttribute(
    'aria-label',
    'Failed: 1 player, your result',
  )
  await expect(page.locator('.celebration')).toHaveCount(0)
})
