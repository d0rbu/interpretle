import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Heatmap from './components/Heatmap'
import { loadCatalog, loadFeature } from './data/puzzles'
import {
  browserModelReady,
  prepareBrowserModel,
  scoreInBrowser,
} from './lib/browser'
import {
  MAX_CUSTOM_LENGTH,
  MAX_GUESSES,
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
  serializeGame,
  shareText,
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
        Find text that strongly activates a hidden feature in a language model.
      </p>
      <ol>
        <li>
          Start with the free clue, near the <strong>50th percentile</strong>.
          Its highlighted tokens are your first hint.
        </li>
        <li>
          Choose one of eight passages and test it. Reading its context is free.
        </li>
        <li>
          Each guess reveals token activations and the passage’s maximum. Tap a
          highlighted token to inspect its score.
        </li>
        <li>
          Reach the <strong>99.9th percentile</strong> within{' '}
          <strong>eight attempts</strong>. You can use up to two custom
          sentences.
        </li>
      </ol>
      <p>
        A passage’s score is its strongest token, ranked among passages where
        the feature activates. Inactive tokens have no highlight. The model
        reads full source context; only the displayed passage is scored.
      </p>
      <p>
        Daily puzzles change at midnight UTC. Use the day number to revisit past
        puzzles. Progress stays in this browser.
      </p>
      <details className="data-details">
        <summary>About the model and data</summary>
        <p>
          Stored scores come from Gemma 4 E4B, layer 21, using Decode Research’s
          SAE. Practice also includes residual coordinates. Text comes from
          OpenAssistant, TinyStories, MBPP, and Wikipedia; each passage links to
          its source.
        </p>
        <p>
          Custom scoring downloads a model and runs on your device with WebGPU.
          Your text is never sent to a scoring server.
        </p>
        <a href="/puzzles/provenance.json" target="_blank" rel="noreferrer">
          Data provenance
        </a>
      </details>
      <button className="primary" onClick={close} autoFocus>
        Play
      </button>
    </dialog>
  )
}

function Context({ passage }: { passage: Passage }) {
  return (
    <details className="context">
      <summary>Context</summary>
      <p>
        {passage.before}
        <strong>{passage.text}</strong>
        {passage.after}
      </p>
      <a href={passage.source.url} target="_blank" rel="noreferrer">
        {passage.source.title}
      </a>
      <span className="source-license"> · {passage.source.license}</span>
    </details>
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
      <div className="result-heading">
        <h2>{label}</h2>
        <span title={`Maximum activation: ${result.rawMax.toPrecision(6)}`}>
          {scoreLabel(result.score, result.rawMax > 0)}
        </span>
      </div>
      <Heatmap text={passage.text} tokens={passage.tokens} feature={feature} />
      <Context passage={passage} />
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
  const [selected, setSelected] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [saveWarning, setSaveWarning] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [shareFallback, setShareFallback] = useState('')
  const [localReady, setLocalReady] = useState(browserModelReady)
  const controller = useRef<AbortController | null>(null)
  const phase = status(game)
  const cards = choices(game, feature)
  const best = bestScore(game)
  const active = game.guesses.some((guess) => guess.rawMax > 0)
  useEffect(() => {
    setSaveWarning(!remember(storageKey(game), serializeGame(game)))
  }, [game])
  useEffect(() => () => controller.current?.abort(), [])

  async function loadModel() {
    if (busy || !catalog.browserModel) return
    setError('')
    setBusy('Preparing the local model…')
    controller.current = new AbortController()
    try {
      await prepareBrowserModel(
        catalog.browserModel,
        setBusy,
        controller.current.signal,
      )
      setLocalReady(true)
    } catch (cause) {
      setLocalReady(false)
      setError(
        cause instanceof Error
          ? cause.message
          : 'The model could not be loaded. No attempt was used.',
      )
    } finally {
      setBusy('')
      controller.current = null
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      let next: Game
      if (custom) {
        const input = validateCustom(game, text)
        if (!catalog.browserModel)
          throw new Error(
            'The local model is not available yet. Stored passages are ready to play.',
          )
        if (!localReady)
          throw new Error('Load the local model first. No attempt was used.')
        setBusy('Scoring locally…')
        controller.current = new AbortController()
        const tokens = await scoreInBrowser(
          input,
          feature,
          catalog.browserModel,
          setBusy,
          controller.current.signal,
        )
        next = playCustom(game, feature, input, tokens)
      } else {
        if (!selected) return
        next = playPassage(game, feature, selected)
      }
      setGame(next)
      setSelected(null)
      setText('')
      setCustom(false)
      const guess = next.guesses.at(-1)!
      setAnnouncement(
        `Attempt ${next.guesses.length}: ${scoreLabel(guess.score, guess.rawMax > 0)}. ${status(next) === 'won' ? 'Puzzle solved.' : `${MAX_GUESSES - next.guesses.length} attempts left.`}`,
      )
    } catch (cause) {
      setLocalReady(browserModelReady())
      setError(
        cause instanceof Error
          ? cause.message
          : 'Scoring failed. No attempt was used.',
      )
    } finally {
      setBusy('')
      controller.current = null
    }
  }

  async function share() {
    const result = shareText(game, catalog.firstDay)
    try {
      await navigator.clipboard.writeText(result)
      setAnnouncement('Result copied.')
    } catch {
      setShareFallback(result)
    }
  }

  return (
    <>
      <div className="game-status">
        <span>
          {phase === 'playing'
            ? `Attempt ${game.guesses.length + 1} of ${MAX_GUESSES}`
            : `${game.guesses.length} of ${MAX_GUESSES} attempts`}
        </span>
        <span>
          Best: <strong>{scoreLabel(best, active)}</strong>
        </span>
        {mode === 'practice' && (
          <button
            className="text-button"
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
              <div className="result-heading">
                <h2>Guess {index + 1}</h2>
                <span
                  title={`Maximum activation: ${guess.rawMax.toPrecision(6)}`}
                >
                  {scoreLabel(guess.score, guess.rawMax > 0)}
                </span>
              </div>
              <Heatmap
                text={guess.text}
                tokens={guess.tokens}
                feature={feature}
              />
              {guess.passageId && (
                <Context
                  passage={feature.passages.find(
                    (p) => p.id === guess.passageId,
                  )!}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {phase === 'playing' ? (
        <form onSubmit={submit}>
          <div className="choice-heading">
            <h2>Choose a passage</h2>
            <button
              type="button"
              className="text-button"
              disabled={!!busy || customRemaining(game) === 0}
              onClick={() => {
                setCustom(!custom)
                setError('')
              }}
            >
              {custom
                ? 'Suggested passages'
                : `Write your own (${customRemaining(game)} left)`}
            </button>
          </div>
          {custom ? (
            <div className="custom-input">
              <label htmlFor="custom-passage">Your sentence</label>
              <textarea
                id="custom-passage"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={3}
                disabled={!!busy}
                autoFocus
                aria-describedby="custom-note"
              />
              <p id="custom-note">
                {catalog.browserModel
                  ? `Scored locally with WebGPU. First use downloads ${(catalog.browserModel.bytes / 1e9).toFixed(1)} GB; later attempts use the cached model.`
                  : 'Custom scoring is unavailable until the browser model is ready. Suggested passages use measured activations.'}{' '}
                {Array.from(text).length}/{MAX_CUSTOM_LENGTH} characters.
              </p>
              {catalog.browserModel && !localReady && (
                <button
                  type="button"
                  className="secondary"
                  onClick={loadModel}
                  disabled={!!busy}
                >
                  Download &amp; load local model
                </button>
              )}
              {localReady && <p className="notice">Local model ready.</p>}
            </div>
          ) : (
            <div className="choices">
              {cards.map((passage) => (
                <article
                  key={passage.id}
                  className={
                    selected === passage.id ? 'choice selected' : 'choice'
                  }
                >
                  <button
                    type="button"
                    className="passage-select"
                    aria-pressed={selected === passage.id}
                    disabled={!!busy}
                    onClick={() => setSelected(passage.id)}
                  >
                    {passage.text.replace(/^\n+|\n+$/g, '')}
                  </button>
                  <Context passage={passage} />
                </article>
              ))}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {busy && (
            <p className="notice" role="status">
              {busy}{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => controller.current?.abort()}
              >
                Cancel
              </button>
            </p>
          )}
          <div className="submit-row">
            <span>Goal: 99.9th percentile</span>
            <button
              type="submit"
              className="primary"
              disabled={
                !!busy || (custom ? !text.trim() || !localReady : !selected)
              }
            >
              {busy ? 'Scoring…' : custom ? 'Test sentence' : 'Test passage'}
            </button>
          </div>
        </form>
      ) : (
        <section className="reveal">
          <h2>{phase === 'won' ? 'Solved.' : 'Out of attempts.'}</h2>
          <p>
            <strong>{feature.title}</strong> — {feature.description}
          </p>
          <p className="target-id">
            Gemma 4 E4B · layer 21 ·{' '}
            {feature.kind === 'sae' ? 'SAE feature' : 'residual coordinate'}{' '}
            {feature.index}
          </p>
          <button className="primary" onClick={share}>
            Share result
          </button>
          {shareFallback && (
            <textarea
              aria-label="Copy your result"
              readOnly
              value={shareFallback}
            />
          )}
        </section>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
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
  const [feature, setFeature] = useState<Feature | null>(null)
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
    <p role="status">Loading puzzle…</p>
  )
}

export default function App() {
  const [today, setToday] = useState(utcDay)
  const [day, setDay] = useState(utcDay)
  const [mode, setMode] = useState<Mode>('daily')
  const [practiceSeed, setPracticeSeed] = useState(
    () => stored(PRACTICE_KEY) ?? crypto.randomUUID(),
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
  return (
    <div className="shell">
      <a className="skip-link" href="#puzzle">
        Skip to puzzle
      </a>
      <header>
        <div className="identity">
          <h1>interpretle</h1>
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
          <time id="puzzle-date" dateTime={day}>
            {dateLabel(day)}
          </time>
        </div>
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
            newPractice={() => setPracticeSeed(crypto.randomUUID())}
          />
        ) : (
          <p role="status">
            {catalog
              ? 'Today’s puzzle has not been published yet.'
              : 'Loading puzzle…'}
          </p>
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
