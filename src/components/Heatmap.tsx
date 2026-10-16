import { useMemo, useState } from 'react'
import { calibration } from '../lib/scoring'
import { scoreLabel } from '../lib/game'
import type { Feature, TokenActivation } from '../lib/types'

// Some Unicode characters span several tokenizer tokens. Merge overlapping
// offsets for display, retaining each underlying token in the inspection text.
export function segments(text: string, tokens: TokenActivation[]) {
  const result: { start: number; end: number; tokens: TokenActivation[] }[] = []
  for (const token of tokens) {
    const previous = result.at(-1)
    if (previous && token.start < previous.end) {
      previous.end = Math.max(previous.end, token.end)
      previous.tokens.push(token)
    } else result.push({ start: token.start, end: token.end, tokens: [token] })
  }
  let end = 0
  return result
    .flatMap((segment) => {
      const items = []
      if (segment.start > end)
        items.push({
          text: text.slice(end, segment.start),
          tokens: [] as TokenActivation[],
        })
      items.push({
        text: text.slice(segment.start, segment.end),
        tokens: segment.tokens,
      })
      end = segment.end
      return items
    })
    .concat(end < text.length ? [{ text: text.slice(end), tokens: [] }] : [])
}

export default function Heatmap({
  text,
  tokens,
  feature,
}: {
  text: string
  tokens: TokenActivation[]
  feature: Feature
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const parts = useMemo(() => segments(text, tokens), [text, tokens])
  const reference = useMemo(
    () => calibration(feature.reference),
    [feature.reference],
  )
  const inspected = selected === null ? null : parts[selected]
  return (
    <div className="heatmap">
      <p className="heatmap-text">
        {parts.map((part, index) => {
          if (!part.tokens.length) return part.text
          const activation = Math.max(
            ...part.tokens.map((token) => token.activation),
          )
          return (
            <button
              type="button"
              key={index}
              className="token"
              aria-pressed={selected === index}
              aria-label={`${JSON.stringify(part.text)}: activation ${activation.toPrecision(5)}`}
              style={{
                backgroundColor:
                  activation > 0
                    ? `rgb(234 150 62 / ${0.12 + 0.62 * Math.min(1, activation / feature.displayScale)})`
                    : 'transparent',
              }}
              title={`Activation ${activation.toPrecision(5)} · ${scoreLabel(reference.percentile(activation), activation > 0)}`}
              onClick={() => setSelected(selected === index ? null : index)}
            >
              {part.text}
            </button>
          )
        })}
      </p>
      {inspected && (
        <div className="token-readout" role="status">
          {inspected.tokens.map((token, index) => (
            <span key={index}>
              Token {token.id}:{' '}
              <strong>{token.activation.toPrecision(5)}</strong> ·{' '}
              {scoreLabel(
                reference.percentile(token.activation),
                token.activation > 0,
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
