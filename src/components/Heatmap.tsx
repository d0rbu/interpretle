import type { ReactNode } from 'react'
import type { Feature, TokenSpan } from '../lib/types'

// Some Unicode characters span several tokenizer tokens. Merge overlapping
// offsets for display, retaining the strongest activation in the highlight.
export function segments<T extends TokenSpan>(text: string, tokens: T[]) {
  const result: { start: number; end: number; tokens: T[] }[] = []
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
          tokens: [] as T[],
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
  loading = false,
}: {
  text: string
  tokens: (TokenSpan & { activation?: number })[]
  feature?: Feature
  before?: string
  loading?: boolean
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
    const activation = Math.max(
      0,
      ...part.tokens.map((token) => token.activation ?? 0),
    )
    // A small nonzero tint keeps weak activations visible on every feature's scale.
    const strength =
      feature && activation > 0
        ? Math.min(1, activation / feature.displayScale)
        : 0
    let content = part.text
    let start = 0
    if (!feature && !loading && before === undefined) {
      if (index === 0) {
        content = content.replace(/^\n+/, '')
        start = part.text.length - content.length
      }
      if (index === parts.length - 1) content = content.replace(/\n+$/, '')
    }
    // Spaces stay inline to preserve wrapping, but move with the highlighted
    // text. Track original offsets so trimming blank lines keeps stable IDs.
    for (const match of content.matchAll(/[^\S\r\n]+|\r\n?|\n|\S+/g)) {
      const value = match[0]
      const piece = start + match.index
      const space = /^\s+$/.test(value)
      const node = (
        <span
          key={`${index}-${piece}`}
          className={`${(feature || loading) && part.tokens.length ? 'token' : 'passage-token'}${space ? ' token-space' : ''}`}
          data-flow={
            space && !/[\r\n]/.test(value) ? `${index}-${piece}` : undefined
          }
          style={{
            backgroundColor: loading
              ? undefined
              : strength > 0
                ? `light-dark(color-mix(in srgb, #ea963ed1 ${20 + 80 * strength}%, transparent), color-mix(in srgb, #965514 ${Math.min(100, 20 + 160 * strength)}%, transparent))`
                : 'transparent',
            animationDelay: loading
              ? `${(900 * index) / Math.max(1, parts.length - 1)}ms`
              : undefined,
          }}
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
  const Tag = feature || loading ? 'p' : 'span'
  return (
    <Tag
      className={`${feature || loading ? 'heatmap-text' : 'passage-text'}${loading ? ' heatmap-loading' : ''}`}
    >
      {before !== undefined && (
        <span className="preceding-context">{before}</span>
      )}
      {before === undefined ? highlighted : <strong>{highlighted}</strong>}
    </Tag>
  )
}
