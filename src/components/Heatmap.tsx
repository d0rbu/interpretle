import type { CSSProperties, ReactNode } from 'react'
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
  feature?: Feature
  before?: string
}) {
  const parts = segments(text, tokens)
  const highlighted: ReactNode[] = []
  let word: ReactNode[] = []
  const finishWord = () => {
    if (word.length)
      highlighted.push(
        <span className="passage-word" key={`word-${highlighted.length}`}>
          {word}
        </span>,
      )
    word = []
  }
  parts.forEach((part, index) => {
    const activation = Math.max(...part.tokens.map((token) => token.activation))
    let content = part.text
    if (!feature && before === undefined) {
      if (index === 0) content = content.replace(/^\n+/, '')
      if (index === parts.length - 1) content = content.replace(/\n+$/, '')
    }
    // Keep words together and whitespace outside moving pieces so a token
    // spanning a line break never stretches during the transition.
    for (const [piece, value] of (content.match(/\s+|\S+/g) ?? []).entries()) {
      const space = /^\s+$/.test(value)
      const node = (
        <span
          key={`${index}-${piece}`}
          className={`${feature && part.tokens.length ? 'token' : 'passage-token'}${space ? ' token-space' : ''}`}
          style={
            {
              backgroundColor:
                feature && activation > 0
                  ? `rgb(234 150 62 / ${0.12 + 0.62 * Math.min(1, activation / feature.displayScale)})`
                  : 'transparent',
            } as CSSProperties
          }
        >
          {value}
        </span>
      )
      if (space) {
        finishWord()
        highlighted.push(node)
      } else
        word.push(
          <span
            className="passage-piece"
            key={`${index}-${piece}`}
            data-flow={`${index}-${piece}`}
          >
            {node}
          </span>,
        )
    }
  })
  finishWord()
  const Tag = feature ? 'p' : 'span'
  return (
    <Tag className={feature ? 'heatmap-text' : 'passage-text'}>
      {before !== undefined && (
        <span className="preceding-context">{before}</span>
      )}
      {before === undefined ? highlighted : <strong>{highlighted}</strong>}
    </Tag>
  )
}
