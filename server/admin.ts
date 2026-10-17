// HTTP Basic authentication over HTTPS; the password lives in a Worker secret.
export async function authorized(request: Request, password?: string) {
  if (!password) return false
  const supplied = request.headers.get('Authorization') ?? ''
  if (supplied.length > 512) return false
  const digest = (text: string) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const [actual, expected] = await Promise.all([
    digest(supplied),
    digest('Basic ' + btoa('henry:' + password)),
  ])
  const bytes = new Uint8Array(expected)
  return (
    new Uint8Array(actual).reduce(
      (diff, byte, i) => diff | (byte ^ bytes[i]),
      0,
    ) === 0
  )
}

interface BrowserStats {
  id: string
  visits: number
  practiceRounds: number
  guesses: number
  writeins: number
  wins: number
  losses: number
  themes: string
}
interface Stats {
  day: string
  players: number
  returning: number
  visits: number
  practiceRounds: number
  practice: { rounds: number; players: number }[]
  counters: ({ event: string; count: number } & Record<
    string,
    string | number
  >)[]
  browsers: BrowserStats[]
  browser?: BrowserStats & {
    firstDay: string
    history: Record<string, string | number>[]
  }
}
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ]!,
  )

export async function statsPage(response: Response) {
  if (!response.ok) return response
  const stats: Stats = await response.json()
  const table = (headings: string[], rows: unknown[][], browserLinks = false) =>
    `<div class="table"><table><thead><tr>${headings.map((h) => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v, i) => `<td>${browserLinks && i === 0 ? `<a href="/admin?day=${escape(stats.day)}&amp;browser=${encodeURIComponent(String(v))}" title="${escape(v)}">${escape(String(v).slice(0, 8))}</a>` : escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  const total = (event: string, field?: string, value?: string) =>
    stats.counters
      .filter((row) => row.event === event && (!field || row[field] === value))
      .reduce((sum, row) => sum + row.count, 0)
  const summary = [
    ['Browsers', stats.players],
    ['Returning browsers', stats.returning],
    ['Visits', stats.visits],
    ['Daily games started', total('game_start', 'mode', 'daily')],
    ['Practice rounds started', stats.practiceRounds],
    ['Wins', total('finish', 'outcome', 'won')],
    ['Failed games', total('finish', 'outcome', 'lost')],
    ['Write-ins opened', total('writein_open')],
    ['Shares', total('share')],
    ['Model errors', total('model_error')],
  ]
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interpretle stats</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui}body{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:24px}h2{font-size:18px;margin-top:32px}a{color:inherit}form{display:flex;flex-wrap:wrap;gap:12px;align-items:center}input,button{font:inherit;padding:6px 10px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}dl div{padding:16px;background:light-dark(#f4f4f3,#222);border-radius:10px}dt{font-size:13px}dd{font-size:28px;margin:4px 0 0}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}td,th{padding:10px;border-bottom:1px solid light-dark(#ddd,#333)}p{color:light-dark(#666,#aaa)}
</style><h1>interpretle · private stats</h1><form action="/admin"><label>Pacific day <input type="date" name="day" value="${escape(stats.day)}"></label><label>Browser ID <input name="browser" value="${escape(stats.browser?.id ?? '')}" placeholder="All browsers"></label><button>View</button></form>
<dl>${summary.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
<p>Browsers use a random saved ID, not a count of people. Rounds begin with the first submitted guess. Custom text stays on the player's device.</p>
${
  stats.browser
    ? `<h2>Browser ${escape(stats.browser.id.slice(0, 8))}</h2>
<p>First seen ${escape(stats.browser.firstDay)} · ${escape(stats.browser.visits)} visits · ${escape(stats.browser.practiceRounds)} practice rounds · ${escape(stats.browser.wins)} wins · ${escape(stats.browser.losses)} losses · ${escape(stats.browser.writeins)} write-ins / ${escape(stats.browser.guesses)} guesses</p>
<p>Settings / displayed themes: ${escape(stats.browser.themes || 'Not yet recorded')}</p>
${table(
  [
    'Played on',
    'Mode',
    'Puzzle / round',
    'Concept',
    'Result',
    'Attempts',
    'Setting / theme',
  ],
  stats.browser.history.map((row) => [
    row.day,
    row.mode,
    row.round ?? '—',
    row.feature,
    row.outcome,
    row.attempt,
    row.themePreference ? `${row.themePreference} / ${row.theme}` : '—',
  ]),
)}
<p>Latest 200 completed rounds. Detailed browser history starts with this release; older aggregate totals remain available.</p>`
    : ''
}
<h2>Browsers on this day</h2>${table(
      [
        'Browser',
        'Setting / theme',
        'Visits',
        'Practice rounds',
        'Wins',
        'Losses',
        'Write-ins',
        'Guesses',
      ],
      stats.browsers.map((row) => [
        row.id,
        row.themes || '—',
        row.visits,
        row.practiceRounds,
        row.wins,
        row.losses,
        row.writeins,
        row.guesses,
      ]),
      true,
    )}
<p>Select a browser to view its history across days. Up to 200 browsers are shown. Write-ins count submitted guesses, not just opening the card.</p>
<h2>Color theme usage</h2>${table(
      ['Selected setting', 'Displayed theme', 'Visits'],
      [
        ['light', 'light'],
        ['dark', 'dark'],
        ['system', 'light'],
        ['system', 'dark'],
      ].map(([preference, theme]) => [
        preference[0].toUpperCase() + preference.slice(1),
        theme[0].toUpperCase() + theme.slice(1),
        stats.counters
          .filter(
            (row) =>
              row.event === 'theme' &&
              row.themePreference === preference &&
              row.theme === theme,
          )
          .reduce((sum, row) => sum + row.count, 0),
      ]),
    )}
<p>Each visit counts once per selected/displayed combination. A visit can use more than one combination. Theme tracking starts with this release.</p>
<h2>Practice rounds per browser</h2>${table(
      ['Rounds', 'Browsers'],
      stats.practice.map((row) => [row.rounds, row.players]),
    )}
<h2>Suggested options selected</h2>${table(
      [
        'Mode',
        'Concept',
        'Passage',
        'Position',
        'Band',
        'Attempt',
        'Selections',
      ],
      stats.counters
        .filter((row) => row.event === 'guess' && row.passage)
        .map((row) => [
          row.mode,
          row.feature,
          row.passage,
          row.slot,
          row.band,
          row.attempt,
          row.count,
        ]),
    )}
<details><summary>All game and model counters</summary>${table(
      ['Event', 'Details', 'Count'],
      stats.counters.map(({ event, count, ...details }) => [
        event,
        Object.entries(details)
          .map(([key, value]) => `${key}: ${value}`)
          .join(' · '),
        count,
      ]),
    )}</details></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store, no-transform',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  )
}
