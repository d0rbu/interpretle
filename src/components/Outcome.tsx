import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { dateLabel, MAX_GUESSES, shareText, status, utcDay } from '../lib/game'
import type { Feature, Game } from '../lib/types'
import extraction from '../../data/model.json'
import Chevron from './Chevron'

export default function Outcome({
  game,
  feature,
  firstDay,
  celebrate,
}: {
  game: Game
  feature: Feature
  firstDay: string
  celebrate: boolean
}) {
  const won = status(game) === 'won'
  const [copied, setCopied] = useState(false)
  const [fallback, setFallback] = useState('')
  const [counts, setCounts] = useState<number[] | null>(null)
  const [statsError, setStatsError] = useState(false)
  const [confetti, setConfetti] = useState(celebrate)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const section = useRef<HTMLElement>(null)
  const resultId = useRef<string>(crypto.randomUUID())

  useEffect(() => () => clearTimeout(copyTimer.current), [])
  useEffect(() => {
    if (!celebrate) return
    section.current?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'center',
    })
    const timer = setTimeout(() => setConfetti(false), 4000)
    return () => clearTimeout(timer)
  }, [celebrate])

  useEffect(() => {
    if (game.mode !== 'daily') return
    const key = `interpretle:result:${game.seed}`
    try {
      resultId.current = localStorage.getItem(key) ?? resultId.current
      localStorage.setItem(key, resultId.current)
    } catch {
      // The current page can still report its result without browser storage.
    }
    let current = true
    fetch(`/api/results/${game.seed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: resultId.current,
        attempts: won ? game.guesses.length : 0,
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Results unavailable')
        const data = await response.json()
        if (
          !Array.isArray(data.counts) ||
          data.counts.length !== 8 ||
          !data.counts.every(
            (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0,
          ) ||
          !Number.isSafeInteger(data.failed ?? 0) ||
          (data.failed ?? 0) < 0
        )
          throw new Error('Invalid results')
        if (current) setCounts([...data.counts, data.failed ?? 0])
      })
      .catch(() => {
        if (current) setStatsError(true)
      })
    return () => {
      current = false
    }
  }, [game.mode, game.seed, game.guesses.length, won])

  async function share() {
    const text = shareText(game, firstDay, feature)
    try {
      await navigator.clipboard.writeText(text)
      setFallback('')
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 3000)
    } catch {
      setCopied(false)
      setFallback(text)
    }
  }

  return (
    <section className={`reveal${won ? ' solved' : ''}`} ref={section}>
      {confetti && (
        <div className="celebration" aria-hidden="true">
          {Array.from({ length: 36 }, (_, i) => (
            <span
              key={i}
              style={
                {
                  left: `${(i * 31) % 100}%`,
                  backgroundColor: ['#e85b52', '#f0b53f', '#5bad6e', '#729ce1'][
                    i % 4
                  ],
                  animationDelay: `${(i % 7) * 60}ms`,
                  animationDuration: `${2500 + (i % 5) * 180}ms`,
                  '--drift': `${((i * 47) % 200) - 100}px`,
                  '--spin': `${i % 2 ? 640 : -640}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      {won && (
        <div className="solve-sparkle" aria-hidden="true">
          ✨
        </div>
      )}
      <h2>{won ? 'Solved.' : 'Out of attempts.'}</h2>
      {won && (
        <p className="solve-count">
          You found it in {game.guesses.length}{' '}
          {game.guesses.length === 1 ? 'guess' : 'guesses'}!
        </p>
      )}
      <p>
        <strong>{feature.title}</strong> — {feature.description}
      </p>
      {won && (
        <details className="feature-details">
          <summary>
            Concept details <Chevron />
          </summary>
          <dl>
            <dt>Model</dt>
            <dd>
              <a
                href={`https://huggingface.co/${extraction.model}/tree/${extraction.model_revision}`}
                target="_blank"
                rel="noreferrer"
              >
                Gemma 4 E4B
              </a>
            </dd>
            <dt>Layer</dt>
            <dd>
              21 ·{' '}
              {feature.kind === 'mlp'
                ? 'gated MLP, before down projection'
                : 'residual stream after the decoder block'}
            </dd>
            {feature.kind === 'sae' ? (
              <>
                <dt>SAE</dt>
                <dd>
                  <a
                    href={`https://huggingface.co/${extraction.sae}/tree/${extraction.sae_revision}/${extraction.sae_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Decode Research · Matryoshka BatchTopK · 65,536 features · k
                    = 100
                  </a>
                </dd>
                <dt>Feature</dt>
                <dd>
                  {feature.index} ·{' '}
                  <a
                    href={`https://www.neuronpedia.org/gemma-4-e4b/21-matryoshka-res-65k/${feature.index}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Neuronpedia ↗
                  </a>
                </dd>
              </>
            ) : (
              <>
                <dt>{feature.kind === 'mlp' ? 'MLP neuron' : 'Coordinate'}</dt>
                <dd>{feature.index} · positive activation</dd>
              </>
            )}
          </dl>
        </details>
      )}
      {game.mode === 'daily' && (
        <div className="distribution">
          <div className="distribution-heading">
            <h3>
              {game.seed === utcDay() ? 'Today’s solves' : dateLabel(game.seed)}
            </h3>
            {counts && (
              <span>
                {counts
                  .slice(0, 8)
                  .reduce((a, b) => a + b, 0)
                  .toLocaleString()}{' '}
                solved
              </span>
            )}
          </div>
          {counts ? (
            <ol aria-label="Daily puzzle results by number of guesses">
              {counts.map((count, index) => {
                // Older games allowed eight guesses; retain any real results
                // in those buckets without showing empty legacy rows.
                if (index >= MAX_GUESSES && index < 8 && count === 0)
                  return null
                const yours = won
                  ? index + 1 === game.guesses.length
                  : index === 8
                return (
                  <li
                    key={index}
                    className={yours ? 'your-result' : undefined}
                    aria-label={`${index === 8 ? `Failed: ${count} ${count === 1 ? 'player' : 'players'}` : `${index + 1} ${index === 0 ? 'guess' : 'guesses'}: ${count} ${count === 1 ? 'solve' : 'solves'}`}${yours ? ', your result' : ''}`}
                  >
                    <span>{index === 8 ? 'X' : index + 1}</span>
                    <div className="distribution-track">
                      <span
                        style={{
                          width: `${(100 * count) / Math.max(1, ...counts)}%`,
                        }}
                      />
                    </div>
                    <span>{count.toLocaleString()}</span>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="notice" role="status">
              {statsError
                ? 'Daily results are temporarily unavailable.'
                : 'Loading daily results…'}
            </p>
          )}
        </div>
      )}
      <button
        className={`primary share-button${copied ? ' copied' : ''}`}
        onClick={share}
        aria-live="polite"
      >
        {copied ? 'Copied to clipboard' : 'Share result'}
      </button>
      {fallback && (
        <textarea
          aria-label="Copy your result"
          readOnly
          value={fallback}
          onFocus={(event) => event.target.select()}
        />
      )}
    </section>
  )
}
