import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Heatmap from './components/Heatmap'
import { getFeature } from './data/demo'
import {
  MAX_CUSTOM_LENGTH,
  MAX_GUESSES,
  bestScore,
  choices,
  createGame,
  customRemaining,
  demoTokens,
  playCustom,
  playPassage,
  restoreGame,
  serializeGame,
  shareText,
  status,
  storageKey,
  utcDay,
} from './lib/game'
import type { Game, Mode, Passage } from './lib/types'

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      {diagonal ? (
        <path d="M6 18 18 6M6 6h12v12" />
      ) : (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      )}
    </svg>
  )
}

function SignalMark({ large = false }: { large?: boolean }) {
  return (
    <span className={`signal-mark ${large ? 'large' : ''}`} aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  )
}

function percentile(value: number) {
  if (value === 0) return 'Inactive'
  const suffix =
    Number.isInteger(value) && value % 100 !== 11 && value % 10 === 1
      ? 'st'
      : Number.isInteger(value) && value % 100 !== 12 && value % 10 === 2
        ? 'nd'
        : Number.isInteger(value) && value % 100 !== 13 && value % 10 === 3
          ? 'rd'
          : 'th'
  return `${value}${suffix}`
}

function loadGame(mode: Mode, day: string): Game {
  const seed = mode === 'daily' ? day : crypto.randomUUID()
  try {
    return (
      restoreGame(localStorage.getItem(storageKey(mode, day)), mode, seed) ??
      createGame(mode, seed)
    )
  } catch {
    return createGame(mode, seed)
  }
}

function PassageCard({
  passage,
  index,
  selected,
  onSelect,
}: {
  passage: Passage
  index: number
  selected: boolean
  onSelect: () => void
}) {
  return (
    <article className={`passage-card ${selected ? 'selected' : ''}`}>
      <button
        type="button"
        className="passage-select"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="card-top">
          <span className="card-number">0{index + 1}</span>
          <span className="selection-dot" aria-hidden="true">
            {selected ? '✓' : ''}
          </span>
        </span>
        <span className="passage-text">{passage.text}</span>
      </button>
      <details className="passage-context">
        <summary>
          Read context <span aria-hidden="true">+</span>
        </summary>
        <p>{passage.context}</p>
        <span className="context-source">
          Original demo passage · the card text is scored
        </span>
      </details>
    </article>
  )
}

function HowToPlay({ close }: { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      className="help-dialog"
      ref={ref}
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      aria-labelledby="help-title"
    >
      <button
        type="button"
        className="dialog-close"
        aria-label="Close how to play"
        onClick={close}
      >
        ×
      </button>
      <span className="eyebrow">A small experiment in understanding</span>
      <h2 id="help-title">Find the hidden signal.</h2>
      <p>
        A language model can respond to patterns in text: uncertainty, a topic,
        a turn of phrase. Your job is to work out what lights up one hidden
        feature.
      </p>
      <ol className="help-steps">
        <li>
          <strong>Start with a clue.</strong> A free passage peaks at the 50th
          percentile. Its highlighted words give you something to go on.
        </li>
        <li>
          <strong>Pick a passage.</strong> Choose from eight options, then test
          it. Scores stay hidden until you play. Reading context is free.
        </li>
        <li>
          <strong>Follow the highlights.</strong> Every guess reveals word
          highlights and its maximum score. Click a word to inspect it. Stronger
          orange means a stronger response.
        </li>
        <li>
          <strong>Reach the 99.9th percentile.</strong> You have eight attempts,
          including up to two sentences of your own. Better guesses unlock
          stronger options.
        </li>
      </ol>
      <p className="help-note">
        <strong>What the score means.</strong> A passage is scored by its
        strongest token, then ranked among passages where the feature activates.
        Zero means inactive. The free clue does not count as an attempt or
        advance your best score.
      </p>
      <p className="help-note">
        <strong>This is a game prototype.</strong> Scores and word highlights
        are hand-authored or produced by a toy keyword rule. They are not Gemma
        measurements. Real SAE inference and model tokenization are the next
        step.
      </p>
      <p className="help-note">
        The daily puzzle is shared and resets at midnight UTC. Practice offers
        fresh shuffled rounds from three demo themes. Progress stays in this
        browser; custom text is not sent to a server.
      </p>
      <button type="button" className="primary-button" onClick={close}>
        Let’s play <Arrow />
      </button>
    </dialog>
  )
}

export default function App() {
  const [day, setDay] = useState(utcDay)
  const [mode, setMode] = useState<Mode>('daily')
  const [game, setGame] = useState(() => loadGame('daily', utcDay()))
  const [selected, setSelected] = useState<string | null>(null)
  const [inputMode, setInputMode] = useState<'passages' | 'custom'>('passages')
  const [customText, setCustomText] = useState('')
  const [help, setHelp] = useState(false)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [saveWarning, setSaveWarning] = useState(false)
  const [shareFallback, setShareFallback] = useState('')
  const boardHeading = useRef<HTMLHeadingElement>(null)
  const feedback = useRef<HTMLElement>(null)
  const feature = getFeature(game.featureId)
  const cards = useMemo(() => choices(game), [game])
  const starterTokens = useMemo(
    () => demoTokens(feature.starter.text, 50, feature.id),
    [feature],
  )
  const best = bestScore(game)
  const phase = status(game)
  const remaining = customRemaining(game)
  const lastGuess = game.guesses.at(-1)

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(game.mode, day), serializeGame(game))
      setSaveWarning(false)
    } catch {
      setSaveWarning(true)
    }
  }, [game, day])

  useEffect(() => {
    const checkDate = () => {
      const nextDay = utcDay()
      if (nextDay === day) return
      setDay(nextDay)
      if (mode === 'daily') {
        setGame(loadGame('daily', nextDay))
        setSelected(null)
        setCustomText('')
        setError('')
        setShareFallback('')
        setAnnouncement('A new daily puzzle is ready.')
      }
    }
    const timer = window.setInterval(checkDate, 15000)
    window.addEventListener('focus', checkDate)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', checkDate)
    }
  }, [day, mode])

  function switchMode(next: Mode) {
    if (next === mode) return
    setMode(next)
    setGame(loadGame(next, day))
    setSelected(null)
    setInputMode('passages')
    setCustomText('')
    setError('')
    setAnnouncement('')
    setShareFallback('')
  }

  function newPractice() {
    setMode('practice')
    setGame(createGame('practice', crypto.randomUUID()))
    setSelected(null)
    setInputMode('passages')
    setCustomText('')
    setError('')
    setAnnouncement('A fresh practice puzzle is ready.')
    setShareFallback('')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const next =
        inputMode === 'custom'
          ? playCustom(game, customText)
          : selected
            ? playPassage(game, selected)
            : null
      if (!next) return
      const guess = next.guesses.at(-1)!
      setGame(next)
      setSelected(null)
      setCustomText('')
      setInputMode('passages')
      setError('')
      setAnnouncement(
        `Attempt ${next.guesses.length}: ${guess.score === 0 ? 'inactive' : `${guess.score}th percentile`}. ${status(next) === 'won' ? 'You found the signal!' : `${MAX_GUESSES - next.guesses.length} attempts left.`}`,
      )
      requestAnimationFrame(() => {
        const target =
          status(next) === 'playing' ? feedback.current : boardHeading.current
        target?.focus({ preventScroll: true })
        target?.scrollIntoView({ block: 'nearest' })
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.')
    }
  }

  async function share() {
    const text = shareText(game)
    try {
      await navigator.clipboard.writeText(text)
      setAnnouncement('Spoiler-free result copied.')
    } catch {
      setShareFallback(text)
    }
  }

  const dateLabel = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`))

  return (
    <>
      <a className="skip-link" href="#game-board">
        Skip to puzzle
      </a>
      <div className="site-shell">
        <header className="site-header">
          <a className="brand" href="/" aria-label="Interpretle home">
            <SignalMark />
            <span>
              interpretle<span className="brand-period">.</span>
            </span>
          </a>
          <nav className="mode-switch" aria-label="Puzzle mode">
            <button
              type="button"
              className={mode === 'daily' ? 'active' : ''}
              aria-pressed={mode === 'daily'}
              onClick={() => switchMode('daily')}
            >
              Daily <span className="daily-dot" />
            </button>
            <button
              type="button"
              className={mode === 'practice' ? 'active' : ''}
              aria-pressed={mode === 'practice'}
              onClick={() => switchMode('practice')}
            >
              Practice
            </button>
          </nav>
          <button
            type="button"
            className="help-button"
            aria-label="How to play"
            onClick={() => setHelp(true)}
          >
            <span className="question-icon" aria-hidden="true">
              ?
            </span>
            <span>How to play</span>
          </button>
        </header>

        <main>
          <section className="intro" aria-labelledby="intro-title">
            <div>
              <p className="eyebrow">
                <span className="tiny-cross" aria-hidden="true">
                  ✳
                </span>{' '}
                A daily dose of interpretability
              </p>
              <h1 id="intro-title">
                Find the words.
                <br className="mobile-break" /> <em>Follow the signal.</em>
              </h1>
              <p className="intro-description">
                One hidden pattern. Eight attempts. Discover what makes it light
                up.
              </p>
            </div>
            <div className="intro-art">
              <SignalMark large />
              <span>Curiosity is all you need.</span>
            </div>
          </section>

          <div className="puzzle-meta">
            <div>
              <span className="live-dot" />
              <strong>
                {mode === 'daily'
                  ? `Daily puzzle · ${dateLabel}`
                  : 'Practice puzzle'}
              </strong>
              <span className="meta-divider">/</span>
              <span>Hidden feature</span>
            </div>
            <span className="demo-label">Illustrative scores</span>
          </div>

          <div className="game-layout">
            <section className="play-area" id="game-board" aria-label="Puzzle">
              <div className="scoreboard">
                <div className="best-score">
                  <span className="eyebrow">Your best</span>
                  <div>
                    <strong>{best === 0 ? '0' : best}</strong>
                    <span>{best === 0 ? 'inactive' : 'percentile'}</span>
                  </div>
                </div>
                <div className="signal-meter">
                  <div className="meter-labels">
                    <span>A little warmer with every discovery</span>
                    <strong>Goal: 99.9</strong>
                  </div>
                  <div
                    className="meter-track"
                    role="progressbar"
                    aria-label="Best activation percentile"
                    aria-valuemin={0}
                    aria-valuemax={99.9}
                    aria-valuenow={Math.min(best, 99.9)}
                  >
                    <div
                      style={{
                        width: `${Math.min((best / 99.9) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <div className="meter-ticks">
                    <span>Inactive</span>
                    <span>50</span>
                    <span>99.9 ✳</span>
                  </div>
                </div>
              </div>

              <div className="starter-panel">
                <div className="section-label">
                  <span>
                    <span className="small-spark" aria-hidden="true">
                      ✳
                    </span>{' '}
                    Your first clue
                  </span>
                  <span className="score-chip">
                    Max 50th <span>percentile</span>
                  </span>
                </div>
                <Heatmap key={game.id} tokens={starterTokens} />
                <div className="starter-footer">
                  <span>Free clue · demo word highlights. Tap to inspect.</span>
                  <span className="heat-legend">
                    Low <i />
                    <i />
                    <i /> High
                  </span>
                </div>
              </div>

              {lastGuess && phase === 'playing' && (
                <section
                  className="latest-result"
                  ref={feedback}
                  tabIndex={-1}
                  aria-label="Latest result"
                >
                  <div className="section-label">
                    <span>
                      Experiment {String(game.guesses.length).padStart(2, '0')}
                    </span>
                    <span className="score-chip">
                      {lastGuess.score === 0
                        ? 'Inactive'
                        : `Max ${percentile(lastGuess.score)} percentile`}
                    </span>
                  </div>
                  <Heatmap
                    key={`${game.id}-${game.guesses.length}`}
                    tokens={lastGuess.tokens}
                  />
                  <p>What do the highlighted words have in common?</p>
                </section>
              )}

              {phase === 'playing' ? (
                <>
                  <div className="round-heading">
                    <div>
                      <p className="eyebrow">
                        Attempt {game.guesses.length + 1} of {MAX_GUESSES}
                      </p>
                      <h2 ref={boardHeading} tabIndex={-1}>
                        What else might light it up?
                      </h2>
                    </div>
                    <div
                      className="attempt-dots"
                      role="img"
                      aria-label={`${game.guesses.length} of ${MAX_GUESSES} attempts used`}
                    >
                      {Array.from({ length: MAX_GUESSES }, (_, i) => (
                        <span
                          key={i}
                          className={
                            i < game.guesses.length
                              ? 'used'
                              : i === game.guesses.length
                                ? 'current'
                                : ''
                          }
                        />
                      ))}
                    </div>
                  </div>
                  <div
                    className="input-tabs"
                    role="group"
                    aria-label="Choose how to guess"
                  >
                    <button
                      type="button"
                      aria-pressed={inputMode === 'passages'}
                      className={inputMode === 'passages' ? 'active' : ''}
                      onClick={() => {
                        setInputMode('passages')
                        setError('')
                      }}
                    >
                      Choose a passage <span>8</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={inputMode === 'custom'}
                      className={inputMode === 'custom' ? 'active' : ''}
                      disabled={remaining === 0}
                      onClick={() => {
                        setInputMode('custom')
                        setError('')
                      }}
                    >
                      Write your own <span>{remaining} left</span>
                    </button>
                  </div>

                  <form onSubmit={submit}>
                    {inputMode === 'passages' ? (
                      <div className="passage-grid">
                        {cards.map((passage, index) => (
                          <PassageCard
                            key={passage.id}
                            passage={passage}
                            index={index}
                            selected={selected === passage.id}
                            onSelect={() => setSelected(passage.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="custom-panel">
                        <label htmlFor="custom-sentence">
                          Test your theory.
                        </label>
                        <p>
                          Write a sentence you think will trigger the same
                          hidden pattern.
                        </p>
                        <textarea
                          id="custom-sentence"
                          value={customText}
                          onChange={(e) => setCustomText(e.target.value)}
                          placeholder="I think the feature responds to…"
                          rows={5}
                          aria-describedby="custom-limit"
                          autoFocus
                        />
                        <div
                          id="custom-limit"
                          className={`custom-limit ${Array.from(customText.trim()).length > MAX_CUSTOM_LENGTH ? 'over-limit' : ''}`}
                        >
                          <span>
                            {remaining} custom{' '}
                            {remaining === 1 ? 'sentence' : 'sentences'} left ·
                            counts as one attempt
                          </span>
                          <span>
                            {Array.from(customText.trim()).length}/
                            {MAX_CUSTOM_LENGTH}
                          </span>
                        </div>
                        <p className="custom-demo-note">
                          Demo scoring uses a simple word-matching rule. Your
                          text stays in this browser.
                        </p>
                      </div>
                    )}
                    {error && (
                      <p className="error-message" role="alert">
                        {error}
                      </p>
                    )}
                    <div className="submit-row">
                      <span>
                        {inputMode === 'passages'
                          ? selected
                            ? 'A hunch is a good place to start.'
                            : 'Pick a passage to test your hunch.'
                          : 'Make every word count.'}
                      </span>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={
                          inputMode === 'passages'
                            ? !selected
                            : !customText.trim() ||
                              Array.from(customText.trim()).length >
                                MAX_CUSTOM_LENGTH
                        }
                      >
                        Test {inputMode === 'passages' ? 'passage' : 'sentence'}{' '}
                        <Arrow />
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <section
                  className={`result-panel ${phase}`}
                  aria-labelledby="result-title"
                >
                  <span className="result-symbol" aria-hidden="true">
                    {phase === 'won' ? '✳' : '↗'}
                  </span>
                  <p className="eyebrow">
                    {phase === 'won'
                      ? 'Connection made'
                      : 'An experiment well spent'}
                  </p>
                  <h2 ref={boardHeading} tabIndex={-1} id="result-title">
                    {phase === 'won'
                      ? 'You found the signal.'
                      : 'Every guess tells a story.'}
                  </h2>
                  <p>
                    {phase === 'won'
                      ? `You reached the ${percentile(best)} percentile in ${game.guesses.length} ${game.guesses.length === 1 ? 'attempt' : 'attempts'}.`
                      : `Your best was ${best === 0 ? 'inactive' : `the ${percentile(best)} percentile`}. Here’s the pattern you were looking for.`}
                  </p>
                  <div className="feature-reveal">
                    <span className="eyebrow">The hidden demo pattern</span>
                    <h3>{feature.title}</h3>
                    <p>{feature.description}</p>
                    <span>
                      Hand-authored theme · not an identified Gemma feature
                    </span>
                  </div>
                  <div className="result-actions">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={share}
                    >
                      Share result <Arrow diagonal />
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={newPractice}
                    >
                      Play a practice puzzle
                    </button>
                  </div>
                  {shareFallback && (
                    <label className="share-fallback">
                      Copy your spoiler-free result
                      <textarea
                        readOnly
                        value={shareFallback}
                        onFocus={(e) => e.target.select()}
                        rows={4}
                      />
                    </label>
                  )}
                  {mode === 'daily' && (
                    <p className="reset-note">
                      The next daily puzzle arrives at midnight UTC.
                    </p>
                  )}
                </section>
              )}
            </section>

            <aside className="notebook" aria-labelledby="notebook-title">
              <div className="notebook-heading">
                <span className="eyebrow">Your field notes</span>
                <span aria-hidden="true">↘</span>
              </div>
              <h2 id="notebook-title">Follow your hunches.</h2>
              <p className="notebook-intro">
                Every passage is an experiment. <br />
                The highlights are your clues.
              </p>
              {game.guesses.length === 0 ? (
                <div className="empty-notes">
                  <div className="empty-lines" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <p>Your discoveries will appear here.</p>
                  <span>
                    Start with a passage that feels related to the first clue.
                  </span>
                </div>
              ) : (
                <ol className="guess-history">
                  {game.guesses.map((guess, index) => (
                    <li key={`${game.id}-${index}`}>
                      <div className="guess-heading">
                        <span className="guess-index">
                          {String(index + 1).padStart(2, '0')}
                          <span>
                            {guess.kind === 'custom'
                              ? 'Your sentence'
                              : 'Passage'}
                          </span>
                        </span>
                        <strong
                          className={
                            guess.score === 0
                              ? 'inactive-score'
                              : 'active-score'
                          }
                        >
                          {percentile(guess.score)}
                        </strong>
                      </div>
                      <Heatmap compact tokens={guess.tokens} />
                      <span className="guess-max">
                        {guess.score === 0
                          ? 'No activation'
                          : 'Maximum token score · percentile'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {lastGuess && phase === 'playing' && (
                <div className="next-hint">
                  <span aria-hidden="true">↗</span>
                  <p>
                    {lastGuess.score === 0
                      ? 'A useful contrast. What does this passage lack that the first clue has?'
                      : lastGuess.score < best
                        ? 'Keep your strongest clue in mind. What do its highlighted words have in common?'
                        : best >= 95
                          ? 'You’re close. Look for a passage that expresses the pattern more strongly.'
                          : 'A signal to follow. Look for the same pattern in a different setting.'}
                  </p>
                </div>
              )}
              <div className="field-guide">
                <span className="eyebrow">A note on the numbers</span>
                <p>
                  <strong>99.9</strong> means stronger than 99.9% of passages
                  where this feature activates. Each passage takes the score of
                  its strongest token.
                </p>
                <span>0 = inactive · warmer color = stronger signal</span>
              </div>
              {mode === 'practice' && phase === 'playing' && (
                <button
                  type="button"
                  className="new-practice"
                  onClick={newPractice}
                >
                  Start a fresh practice puzzle <Arrow />
                </button>
              )}
            </aside>
          </div>

          {saveWarning && (
            <p className="save-warning" role="status">
              Browser storage is unavailable. You can keep playing, but progress
              will not survive a refresh.
            </p>
          )}
          <div className="demo-notice">
            <span className="demo-notice-dot" />
            <p>
              <strong>A playable sketch of an idea.</strong> These scores and
              word highlights are illustrative. Real Gemma 4 E4B · layer 21 SAE
              activations are next.
            </p>
            <a
              href="https://github.com/d0rbu/interpretle"
              target="_blank"
              rel="noreferrer"
            >
              Built in the open <Arrow diagonal />
            </a>
          </div>
        </main>
        <footer>
          <span>
            interpretle<span className="brand-period">.</span>
            <span className="footer-tagline">
              A little closer to understanding.
            </span>
          </span>
          <a
            href="https://huggingface.co/decoderesearch/gemma-4-saes"
            target="_blank"
            rel="noreferrer"
          >
            Inspired by sparse autoencoders <Arrow diagonal />
          </a>
        </footer>
      </div>
      <div
        className={`announcement ${announcement ? 'visible' : ''}`}
        role="status"
        aria-live="polite"
        key={announcement}
      >
        {announcement}
      </div>
      {help && <HowToPlay close={() => setHelp(false)} />}
    </>
  )
}
