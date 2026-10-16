import type { Feature, TokenActivation } from '../lib/types'

// Some Unicode characters span several tokenizer tokens. Merge overlapping
// offsets for display, retaining the strongest activation in the highlight.
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
  before,
}: {
  text: string
  tokens: TokenActivation[]
  feature: Feature
  before?: string
}) {
  const highlighted = segments(text, tokens).map((part, index) => {
    if (!part.tokens.length) return part.text
    const activation = Math.max(...part.tokens.map((token) => token.activation))
    return (
      <span
        key={index}
        className="token"
        style={{
          backgroundColor:
            activation > 0
              ? `rgb(234 150 62 / ${0.12 + 0.62 * Math.min(1, activation / feature.displayScale)})`
              : 'transparent',
        }}
      >
        {part.text}
      </span>
    )
  })
  return (
    <p className="heatmap-text">
      {before}
      {before === undefined ? highlighted : <strong>{highlighted}</strong>}
    </p>
  )
}
