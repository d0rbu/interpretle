export default function ModelProgress({
  message,
  value,
}: {
  message: string
  value?: number
}) {
  const scoring = message.startsWith('Scoring:')
  const downloading = message.startsWith('Downloading model')
  const label = scoring
    ? 'Scoring your passage'
    : downloading
      ? 'Downloading model'
      : 'Loading model'
  const detail = message
    .replace('Downloading model: ', '')
    .replace('Scoring: ', '')
  return (
    <>
      <span className="model-progress-label" title={detail}>
        {detail}
      </span>
      <progress aria-label={message} title={message} value={value} max={1} />
      <svg
        className="model-progress-icon"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={label}
      >
        <title>{`${label}: ${detail}`}</title>
        {scoring ? (
          <>
            <rect x="5" y="5" width="10" height="10" rx="1.5" />
            <path d="M8 2v3m4-3v3m-4 10v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3" />
          </>
        ) : downloading ? (
          <path d="M10 3v14m-5-5 5 5 5-5" />
        ) : (
          <path d="M16.1 6a7 7 0 1 0 .9 6M16 2v4h-4" />
        )}
      </svg>
    </>
  )
}
