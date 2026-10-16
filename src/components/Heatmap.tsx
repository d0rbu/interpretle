import { useState } from 'react'
import type { TokenActivation } from '../lib/types'

export default function Heatmap({
  tokens,
  compact = false,
}: {
  tokens: TokenActivation[]
  compact?: boolean
}) {
  const [inspected, setInspected] = useState<number | null>(null)
  const token = inspected === null ? null : tokens[inspected]
  return (
    <div className={`heatmap ${compact ? 'compact' : ''}`}>
      <p className="heatmap-text">
        {tokens.map((item, index) =>
          /^\s+$/u.test(item.text) ? (
            item.text
          ) : (
            <button
              key={index}
              type="button"
              className={`token ${inspected === index ? 'inspected' : ''}`}
              style={{
                backgroundColor:
                  item.activation > 0
                    ? `rgba(212, 119, 57, ${0.1 + (item.percentile / 100) * 0.47})`
                    : 'transparent',
              }}
              title={`${item.text} · demo activation ${item.activation.toFixed(3)} · ${item.percentile}th percentile`}
              aria-label={`${item.text}: demo activation ${item.activation.toFixed(3)}, ${item.percentile}th percentile. Inspect token.`}
              aria-pressed={inspected === index}
              onClick={() => setInspected(inspected === index ? null : index)}
            >
              {item.text}
            </button>
          ),
        )}
      </p>
      {token && (
        <p className="token-readout" role="status">
          <strong>{token.text}</strong>
          <span>Demo activation {token.activation.toFixed(3)}</span>
          <span>{token.percentile}th percentile</span>
        </p>
      )}
    </div>
  )
}
