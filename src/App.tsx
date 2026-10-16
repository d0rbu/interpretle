import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { flushSync } from 'react-dom'
import Heatmap from './components/Heatmap'
import Chevron from './components/Chevron'
import Outcome from './components/Outcome'
import { cachedFeature, loadCatalog, loadFeature } from './data/puzzles'
import {
  browserModelReady,
  prepareBrowserModel,
  scoreInBrowser,
} from './lib/browser'
import {
  MAX_CUSTOM_LENGTH,
  MAX_GUESSES,
  WIN_SCORE,
  bestScore,
  choices,
  createGame,
  customRemaining,
  dateLabel,
  dayNumber,
  hash,
  measure,
  playCustom,
  playPassage,
  restoreGame,
  scoreLabel,
  scoreColor,
  serializeGame,
  status,
  storageKey,
  utcDay,
  validateCustom,
} from './lib/game'
import type { Catalog, Feature, Game, Mode, Passage } from './lib/types'

const HELP_KEY = 'interpretle:instructions-seen'
const PRACTICE_KEY = 'interpretle:practice-seed'
function stored(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function Instructions({ close }: { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby="instructions-title"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <button
        className="close-button"
        onClick={close}
        aria-label="Close instructions"
      >
        ×
      </button>
      <h2 id="instructions-title">How to play</h2>
      <p>
        Find text that lights up a hidden concept in a language model. Select
        the option you think most highly activates the concept you're looking
        for, or write in your own. You only have two write-ins available, and{' '}
        <strong>{MAX_GUESSES} attempts</strong> to find a text passage that
        activates at the <strong>99.9th percentile</strong>.
      </p>
      <button className="primary" onClick={close} autoFocus>
        Play
      </button>
    </dialog>
  )
}

function PassageContent({
  passage,
  label,
  score,
  children,
}: {
  passage?: Passage
  label?: ReactNode
  score?: { score: number; rawMax: number }
  children: (before: string | undefined) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const transition = useRef<ViewTransition | null>(null)
  function toggle(event: MouseEvent<HTMLButtonElement>) {
    const container = event.currentTarget.closest(
      '.choice, .result, .history li',
    ) as
      | (HTMLElement & {
          startViewTransition?: Document['startViewTransition']
        })
      | null
    if (
      !container?.startViewTransition ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setExpanded(!expanded)
      return
    }
    transition.current?.skipTransition()
    container.classList.add('context-motion')
    const motion = container.startViewTransition(() => {
      flushSync(() => setExpanded((value) => !value))
    })
    transition.current = motion
    // A layout change can skip an animation while still applying its update.
    void motion.ready.catch(() => {})
    const finish = () => {
      if (transition.current === motion) {
        container.classList.remove('context-motion')
        transition.current = null
      }
    }
    void motion.finished.then(finish, finish)
  }
  return (
    <>
      <div className="result-heading">
        {label && <h2>{label}</h2>}
        <div className="passage-actions">
          {score && (
            <span title={`Maximum activation: ${score.rawMax.toPrecision(6)}`}>
              {scoreLabel(score.score, score.rawMax > 0)}
            </span>
          )}
          {passage && (
            <button
              type="button"
              className="context-toggle"
              aria-label={
                expanded ? 'Hide preceding context' : 'Show preceding context'
              }
              aria-expanded={expanded}
              onClick={toggle}
            >
              <Chevron />
            </button>
          )}
        </div>
      </div>
      {children(expanded ? passage?.before : undefined)}
    </>
  )
}

function Result({
  passage,
  feature,
  label,
}: {
  passage: Passage
  feature: Feature
  label: string
}) {
  const result = measure(feature, passage.tokens)
  return (
    <section className="result">
      <PassageContent passage={passage} label={label} score={result}>
        {(before) => (
          <Heatmap
            text={passage.text}
            tokens={passage.tokens}
            feature={feature}
            before={before}
          />
        )}
      </PassageContent>
    </section>
  )
}

function Board({
  feature,
  mode,
  seed,
  catalog,
  newPractice,
}: {
  feature: Feature
  mode: Mode
  seed: string
  catalog: Catalog
  newPractice: () => void
}) {
  const [game, setGame] = useState(() => {
    const initial = createGame(mode, seed, feature.id)
    return restoreGame(stored(storageKey(initial)), initial, feature)
  })
  const [text, setText] = useState('')
  const [writing, setWriting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<number>()
  const [error, setError] = useState('')
  const [saveWarning, setSaveWarning] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [celebrate, setCelebrate] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const loading = useRef<Promise<boolean> | null>(null)
  const phase = status(game)
  const cards = choices(game, feature)
  const best = bestScore(game)
  useEffect(() => {
    setSaveWarning(!remember(storageKey(game), serializeGame(game)))
  }, [game])
  useEffect(() => () => controller.current?.abort(), [])

  function reportProgress(message: string, fraction?: number) {
    setBusy(message)
    setProgress(fraction)
  }

  function loadModel() {
    if (browserModelReady()) return Promise.resolve(true)
    if (loading.current) return loading.current
    const model = catalog.browserModel
    if (!model) {
      setError('Custom scoring is unavailable.')
      return Promise.resolve(false)
    }
    setError('')
    reportProgress('Loading…')
    controller.current = new AbortController()
    const signal = controller.current.signal
    loading.current = Promise.resolve()
      .then(() => prepareBrowserModel(model, reportProgress, signal))
      .then(
        () => true,
        (cause) => {
          if (cause instanceof DOMException && cause.name === 'AbortError')
            return false
          setError(
            cause instanceof Error
              ? cause.message
              : 'The model could not be loaded. No attempt was used.',
          )
          return false
        },
      )
      .finally(() => {
        setBusy('')
        controller.current = null
        loading.current = null
      })
    return loading.current
  }

  async function submit(passageId?: string) {
    if (submitting || (passageId && busy)) return
    if (!passageId && !text.trim()) return
    setError('')
    try {
      let next: Game
      if (passageId) {
        next = playPassage(game, feature, passageId)
      } else {
        const input = validateCustom(game, text)
        if (!catalog.browserModel)
          throw new Error(
            'The local model is not available yet. Stored passages are ready to play.',
          )
        setSubmitting(true)
        if (!(await loadModel())) return
        reportProgress('Scoring locally…')
        controller.current = new AbortController()
        const tokens = await scoreInBrowser(
          input,
          feature,
          catalog.browserModel,
          reportProgress,
          controller.current.signal,
        )
        next = playCustom(game, feature, input, tokens)
      }
      setGame(next)
      setCelebrate(status(next) === 'won')
      setText('')
      const guess = next.guesses.at(-1)!
      setAnnouncement(
        `Attempt ${next.guesses.length}: ${scoreLabel(guess.score, guess.rawMax > 0)}. ${status(next) === 'won' ? 'Puzzle solved.' : `${game.maxGuesses - next.guesses.length} attempts left.`}`,
      )
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError(
        cause instanceof Error
          ? cause.message
          : 'Scoring failed. No attempt was used.',
      )
    } finally {
      setSubmitting(false)
      if (!loading.current) {
        setBusy('')
        controller.current = null
      }
    }
  }

  return (
    <>
      <div className="game-status">
        <span>
          {phase === 'playing'
            ? `Attempt ${game.guesses.length + 1} of ${game.maxGuesses}`
            : `${game.guesses.length} of ${game.maxGuesses} attempts`}
        </span>
        <span>
          Best: <strong>{best === 0 ? '0%' : scoreLabel(best)}</strong>
        </span>
        {mode === 'practice' && (
          <button
            className="new-puzzle"
            onClick={newPractice}
            disabled={!!busy}
          >
            New puzzle
          </button>
        )}
      </div>
      {saveWarning && (
        <p className="notice">
          Browser storage is unavailable. Progress will not survive a reload.
        </p>
      )}
      <Result
        passage={feature.starter}
        feature={feature}
        label="Starting clue"
      />
      {game.guesses.length > 0 && (
        <ol className="history" aria-label="Your guesses">
          {game.guesses.map((guess, index) => (
            <li key={index}>
              <PassageContent
                label={
                  <>
                    Guess {index + 1}
                    <span
                      className={`guess-color${guess.score >= WIN_SCORE ? ' sparkle' : ''}`}
                      aria-hidden="true"
                      style={{
                        backgroundColor:
                          guess.score < WIN_SCORE
                            ? scoreColor(guess.score)
                            : undefined,
                      }}
                    >
                      {guess.score >= WIN_SCORE ? '✨' : null}
                    </span>
                  </>
                }
                score={guess}
                passage={feature.passages.find((p) => p.id === guess.passageId)}
              >
                {(before) => (
                  <Heatmap
                    text={guess.text}
                    tokens={guess.tokens}
                    feature={feature}
                    before={before}
                  />
                )}
              </PassageContent>
            </li>
          ))}
        </ol>
      )}
      {phase === 'playing' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="choice-heading">
            <h2>Choose a passage</h2>
          </div>
          <div className="choices">
            {cards.map((passage) => (
              <article key={passage.id} className="choice">
                <PassageContent passage={passage}>
                  {(before) => (
                    <button
                      type="button"
                      className="passage-select"
                      disabled={!!busy}
                      onClick={() => submit(passage.id)}
                    >
                      <Heatmap
                        text={passage.text}
                        tokens={passage.tokens}
                        before={before}
                      />
                    </button>
                  )}
                </PassageContent>
              </article>
            ))}
            <article
              className="choice write-in"
              onFocusCapture={() => setWriting(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setWriting(false)
              }}
            >
              <textarea
                aria-label="Your sentence"
                aria-description="Enter to submit. Shift+Enter for a new line."
                aria-describedby={text || writing ? 'custom-count' : undefined}
                placeholder={`Write your own (${customRemaining(game)} left)`}
                value={text}
                onChange={(event) =>
                  setText(
                    Array.from(event.target.value)
                      .slice(0, MAX_CUSTOM_LENGTH)
                      .join(''),
                  )
                }
                onFocus={() => void loadModel()}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void submit()
                  }
                }}
                rows={3}
                enterKeyHint="send"
                readOnly={submitting}
                disabled={customRemaining(game) === 0}
              />
              {(text || writing || busy) && (
                <div className="write-in-footer">
                  {busy && (
                    <>
                      <progress
                        aria-label={busy}
                        title={busy}
                        value={progress}
                        max={1}
                      />
                      <button
                        type="button"
                        className="cancel-model"
                        onClick={() => controller.current?.abort()}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {(text || writing) && (
                    <span id="custom-count" className="character-count">
                      {Array.from(text).length}/{MAX_CUSTOM_LENGTH}
                    </span>
                  )}
                </div>
              )}
            </article>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <Outcome
          game={game}
          feature={feature}
          firstDay={catalog.firstDay}
          celebrate={celebrate}
        />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  )
}

function PuzzleSkeleton() {
  return (
    <div
      className="puzzle-skeleton"
      role="status"
      aria-label="Loading puzzle"
      aria-busy="true"
    >
      <div aria-hidden="true">
        <div className="game-status">
          <span className="skeleton-line" />
        </div>
        <div className="result skeleton-card">
          <span className="skeleton-line short" />
          <span className="skeleton-line" />
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
        <div className="choice-heading">
          <span className="skeleton-line short" />
        </div>
        <div className="choices">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="choice skeleton-card" key={i}>
              <span className="skeleton-line" />
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Puzzle({
  id,
  ...props
}: {
  id: string
  mode: Mode
  seed: string
  catalog: Catalog
  newPractice: () => void
}) {
  const [feature, setFeature] = useState(() => cachedFeature(id))
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    loadFeature(id)
      .then((value) => {
        if (current) setFeature(value)
      })
      .catch(() => {
        if (current)
          setError('This puzzle could not be loaded. Please reload to retry.')
      })
    return () => {
      current = false
    }
  }, [id])
  return error ? (
    <p role="alert">{error}</p>
  ) : feature ? (
    <Board
      key={`${props.mode}:${props.seed}:${id}`}
      feature={feature}
      {...props}
    />
  ) : (
    <PuzzleSkeleton />
  )
}

export default function App() {
  const [today, setToday] = useState(utcDay)
  const [day, setDay] = useState(utcDay)
  const [mode, setMode] = useState<Mode>('daily')
  const [practiceSeed, setPracticeSeed] = useState(
    () => stored(PRACTICE_KEY) ?? crypto.randomUUID(),
  )
  const [nextPracticeSeed, setNextPracticeSeed] = useState(() =>
    crypto.randomUUID(),
  )
  const [help, setHelp] = useState(() => stored(HELP_KEY) !== '1')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    loadCatalog()
      .then(setCatalog)
      .catch(() =>
        setError('Puzzles could not be loaded. Please reload to retry.'),
      )
  }, [])
  useEffect(() => {
    remember(PRACTICE_KEY, practiceSeed)
  }, [practiceSeed])
  useEffect(() => {
    const check = () => {
      const next = utcDay()
      if (next !== today) {
        setToday(next)
        setDay((current) => (current === today ? next : current))
      }
    }
    const timer = window.setInterval(check, 15000)
    window.addEventListener('focus', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [today])
  const firstDay = catalog?.firstDay ?? '2026-10-16'
  const days = catalog
    ? Object.keys(catalog.daily)
        .filter((date) => date <= today)
        .sort()
        .reverse()
    : [today]
  const id =
    catalog &&
    (mode === 'daily'
      ? catalog.daily[day]
      : catalog.practice[hash(practiceSeed) % catalog.practice.length])
  useEffect(() => {
    if (!catalog) return
    const archive = Object.keys(catalog.daily)
      .filter((date) => date <= today)
      .sort()
    const previous = archive[archive.indexOf(day) - 1]
    const targets = [
      catalog.daily[today],
      catalog.daily[previous],
      ...[practiceSeed, nextPracticeSeed].map(
        (seed) => catalog.practice[hash(seed) % catalog.practice.length],
      ),
    ]
    for (const target of new Set(targets))
      if (target) void loadFeature(target).catch(() => {})
  }, [catalog, today, day, practiceSeed, nextPracticeSeed])
  return (
    <div className="shell">
      <a className="skip-link" href="#puzzle">
        Skip to puzzle
      </a>
      <header>
        <div className="identity">
          <h1>interpretle</h1>
          <span className="day-picker">
            <span className="day-value" aria-hidden="true">
              {dayNumber(day, firstDay)}
              <Chevron />
            </span>
            <select
              aria-label="Puzzle day"
              aria-describedby="puzzle-date"
              value={day}
              onChange={(event) => {
                setDay(event.target.value)
                setMode('daily')
              }}
            >
              {days.map((date) => (
                <option key={date} value={date}>
                  {dayNumber(date, firstDay)}
                </option>
              ))}
            </select>
          </span>
          <time id="puzzle-date" dateTime={day}>
            {dateLabel(day)}
          </time>
        </div>
        <span className="credit">
          Made by{' '}
          <a href="https://x.com/henrycstllo" target="_blank" rel="noreferrer">
            Henry
          </a>{' '}
          and Codex
        </span>
        <nav className="mode-switch" aria-label="Puzzle mode">
          {(['daily', 'practice'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === 'daily' ? 'Daily' : 'Practice'}
            </button>
          ))}
        </nav>
        <button
          className="help-button"
          aria-label="Instructions"
          onClick={() => setHelp(true)}
        >
          ?
        </button>
      </header>
      <main id="puzzle">
        {error ? (
          <p role="alert">{error}</p>
        ) : catalog && id ? (
          <Puzzle
            key={id}
            id={id}
            mode={mode}
            seed={mode === 'daily' ? day : practiceSeed}
            catalog={catalog}
            newPractice={() => {
              setPracticeSeed(nextPracticeSeed)
              setNextPracticeSeed(crypto.randomUUID())
            }}
          />
        ) : catalog ? (
          <p role="status">Today’s puzzle has not been published yet.</p>
        ) : (
          <PuzzleSkeleton />
        )}
      </main>
      {help && (
        <Instructions
          close={() => {
            remember(HELP_KEY, '1')
            setHelp(false)
          }}
        />
      )}
    </div>
  )
}
