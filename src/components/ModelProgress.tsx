export default function ModelProgress({ message }: { message: string }) {
  const scoring = message.startsWith('Scoring locally')
  const label = scoring
    ? 'Scoring your passage'
    : 'Downloading and loading model'
  return (
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
      <title>{`${label}: ${message}`}</title>
      {scoring ? (
        <>
          <rect x="5" y="5" width="10" height="10" rx="1.5" />
          <path d="M8 2v3m4-3v3m-4 10v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3" />
        </>
      ) : (
        <path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" />
      )}
    </svg>
  )
}
