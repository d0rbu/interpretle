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
interface IpStats extends BrowserStats {
  browserCount: number
}
type RoundHistory = Record<string, string | number>[]
type Counters = ({ event: string; count: number } & Record<
  string,
  string | number
>)[]
interface ModelError {
  at: string
  player: string
  ip: string | null
  problem: string
  code: string
  phase: string
  backend: string
  device: string
  browser: string
  os: string
  userAgent: string
  httpStatus?: number
  layer?: number
  cores?: number
  memoryGb?: number
}
interface RecordedGame {
  player: string
  mode: string
  round: string
  feature: string
  firstAt: string
  lastAt: string
  guesses: number
  outcome: string | null
}
interface RecordedEvent {
  seq: number
  event: string
  at?: string
  receivedAt: string
  attempt?: number
  text?: string
  passage?: string
  code?: string
  expanded?: boolean
  snapshot?: {
    game: { guesses: { text: string; score: number }[] }
  }
}
interface Stats {
  day: string
  players: number
  returning: number
  visits: number
  practiceRounds: number
  practice: { rounds: number; players: number }[]
  counters: Counters
  modelErrors: ModelError[]
  modelErrorGroups: (Pick<
    ModelError,
    'problem' | 'code' | 'phase' | 'backend' | 'device' | 'browser' | 'os'
  > & { count: number })[]
  games: RecordedGame[]
  events: RecordedEvent[]
  nextCursor: number | null
  selectedGame: { mode: string; round: string; feature: string } | null
  browsers: BrowserStats[]
  browser?: BrowserStats & {
    firstDay: string
    history: RoundHistory
    addresses: { id: string; firstDay: string; lastDay: string }[]
  }
  ipCount: number
  ips: IpStats[]
  ip?: IpStats & {
    firstDay: string
    lastDay: string
    browsers: BrowserStats[]
    history: RoundHistory
    counters: Counters
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

export async function statsPage(response: Response, download = false) {
  if (!response.ok) return response
  if (download)
    return new Response(response.body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="interpretle-events.json"',
        'Cache-Control': 'private, no-store, no-transform',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  const stats: Stats = await response.json()
  const gameUrl = (
    game?: Pick<RecordedGame, 'player' | 'mode' | 'round' | 'feature'>,
    extra: Record<string, string> = {},
  ) => {
    const params = new URLSearchParams({ day: stats.day })
    if (game) {
      params.set('browser', game.player)
      for (const key of ['mode', 'round', 'feature'] as const)
        params.set(key, game[key])
    } else {
      if (stats.browser) params.set('browser', stats.browser.id)
      if (stats.ip) params.set('ip', stats.ip.id)
    }
    for (const [key, value] of Object.entries(extra)) params.set(key, value)
    return escape('/admin?' + params)
  }
  const selectedGame =
    stats.selectedGame && stats.browser
      ? { player: stats.browser.id, ...stats.selectedGame }
      : undefined
  const link = (kind: 'browser' | 'ip', value: unknown) =>
    `<a href="/admin?day=${escape(stats.day)}&amp;${kind}=${encodeURIComponent(String(value))}" title="${escape(value)}">${escape(kind === 'browser' ? String(value).slice(0, 8) : value)}</a>`
  const table = (
    headings: string[],
    rows: unknown[][],
    linkBy?: 'browser' | 'ip',
  ) =>
    `<div class="table"><table><thead><tr>${headings.map((h) => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v, i) => `<td>${linkBy && i === 0 ? link(linkBy, v) : escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  const history = (rows: RoundHistory, byIp = false) =>
    table(
      [
        ...(byIp ? ['Browser'] : []),
        'Played on',
        'Mode',
        'Puzzle / round',
        'Concept',
        'Result',
        'Attempts',
        'Setting / theme',
      ],
      rows.map((row) => [
        ...(byIp ? [row.player] : []),
        row.day,
        row.mode,
        row.round ?? '—',
        row.feature,
        row.outcome,
        row.attempt,
        row.themePreference ? `${row.themePreference} / ${row.theme}` : '—',
      ]),
      byIp ? 'browser' : undefined,
    )
  const browsers = (rows: BrowserStats[]) =>
    table(
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
      rows.map((row) => [
        row.id,
        row.themes || '—',
        row.visits,
        row.practiceRounds,
        row.wins,
        row.losses,
        row.writeins,
        row.guesses,
      ]),
      'browser',
    )
  const counters = (rows: Counters) =>
    table(
      ['Event', 'Details', 'Count'],
      rows.map(({ event, count, ...details }) => [
        event,
        Object.entries(details)
          .map(([key, value]) => `${key}: ${value}`)
          .join(' · '),
        count,
      ]),
    )
  const total = (event: string, field?: string, value?: string) =>
    stats.counters
      .filter((row) => row.event === event && (!field || row[field] === value))
      .reduce((sum, row) => sum + row.count, 0)
  const summary = [
    ['Browsers', stats.players],
    ['IP addresses', stats.ipCount],
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
:root{color-scheme:light dark;font:16px/1.5 system-ui}body{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:24px}h2{font-size:18px;margin-top:32px;overflow-wrap:anywhere}a{color:inherit;overflow-wrap:anywhere}.table a{white-space:nowrap}form{display:flex;flex-wrap:wrap;gap:12px;align-items:center}input,button{font:inherit;padding:6px 10px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}dl div{padding:16px;background:light-dark(#f4f4f3,#222);border-radius:10px}dt{font-size:13px}dd{font-size:28px;margin:4px 0 0}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px;text-align:left}td,th{padding:10px;border-bottom:1px solid light-dark(#ddd,#333)}p{color:light-dark(#666,#aaa)}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto;font-size:12px}details{margin:12px 0}
</style><h1>interpretle · private stats</h1><form action="/admin"><label>Pacific day <input type="date" name="day" value="${escape(stats.day)}"></label><label>Browser ID <input name="browser" value="${escape(stats.browser?.id ?? '')}" placeholder="All browsers"></label><label>IP address <input name="ip" value="${escape(stats.ip?.id ?? '')}" placeholder="IPv4 or IPv6" maxlength="45"></label><button>View</button></form>
<dl>${summary.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
<p>Browsers use a random saved ID. IP addresses can be shared or change; neither is a count of people. Rounds begin with the first submitted guess. Submitted write-ins and game states are saved privately; unsubmitted drafts are not recorded.</p>
<h2 id="games">Recorded games</h2>
<p>Latest 200 games in this selection, including unfinished games. Open a game for its event timeline and complete board/score data. Browser timestamps reflect the device's clock; receipt times are authoritative UTC. Recording starts with this update; restored older guesses have no original timestamps.</p>
<div class="table"><table><thead><tr>${['Browser', 'First received (UTC)', 'Last received (UTC)', 'Mode', 'Puzzle / round', 'Concept', 'Guesses', 'Result', 'History'].map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${stats.games.map((game) => `<tr><td>${link('browser', game.player)}</td>${[game.firstAt, game.lastAt, game.mode, game.round, game.feature, game.guesses, game.outcome ?? 'Unfinished'].map((value) => `<td>${escape(value)}</td>`).join('')}<td><a href="${gameUrl(game)}">Open game</a></td></tr>`).join('')}</tbody></table></div>
<p><a href="${gameUrl(selectedGame, { format: 'json' })}">Download event JSON</a></p>
${
  selectedGame
    ? `<h3>Game timeline</h3>${table(
        [
          'Event',
          'Browser time (UTC)',
          'Received (UTC)',
          'Attempt',
          'Text / selection',
          'Percentile / detail',
        ],
        stats.events.map((event) => {
          const guess =
            event.event === 'guess'
              ? event.snapshot?.game.guesses.at(-1)
              : undefined
          return [
            event.event,
            event.at ?? 'Unknown',
            event.receivedAt,
            event.attempt ?? '—',
            event.text ?? guess?.text ?? event.passage ?? '—',
            guess?.score ??
              event.code ??
              (event.expanded === undefined
                ? '—'
                : event.expanded
                  ? 'Expanded'
                  : 'Collapsed'),
          ]
        }),
      )}<details><summary>Full event records, boards, and token scores</summary><pre>${escape(JSON.stringify(stats.events, null, 2))}</pre></details>`
    : ''
}
${stats.nextCursor !== null ? `<p>More events are available. <a href="${gameUrl(selectedGame, { after: String(stats.nextCursor) })}">Next page</a> · <a href="${gameUrl(selectedGame, { format: 'json', after: String(stats.nextCursor) })}">Download next JSON page</a></p>` : ''}
<h2 id="model-errors">Model errors</h2>
<p>${stats.browser ? 'This browser across all days.' : stats.ip ? 'This IP across all days.' : `Received on ${escape(stats.day)} (Pacific time).`} Timestamps below are server receipt times in UTC. Device details are browser-reported; missing information is shown as a dash. Detailed records start with this update; older error totals remain in the counters.</p>
${
  stats.modelErrorGroups.length
    ? table(
        [
          'Errors',
          'Category / code',
          'Stage / backend',
          'Device',
          'Browser',
          'OS',
        ],
        stats.modelErrorGroups.map((row) => [
          row.count,
          `${row.problem} / ${row.code}`,
          `${row.phase} / ${row.backend}`,
          row.device,
          row.browser,
          row.os,
        ]),
      )
    : '<p>No detailed model errors recorded for this selection.</p>'
}
${
  stats.modelErrors.length
    ? `<h3>Latest errors</h3>${table(
        [
          'Browser ID',
          'Received (UTC)',
          'IP',
          'Error',
          'Stage / backend',
          'Device / browser / OS',
          'Logical cores / approximate RAM',
        ],
        stats.modelErrors.map((row) => [
          row.player,
          row.at.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'),
          row.ip ?? '—',
          `${row.code}${row.httpStatus ? ` (HTTP ${row.httpStatus})` : ''}`,
          `${row.phase}${row.layer !== undefined ? ` · layer ${row.layer}` : ''} / ${row.backend}`,
          `${row.device} / ${row.browser} / ${row.os}`,
          `${row.cores ?? '—'} / ${row.memoryGb !== undefined ? `${row.memoryGb} GB` : '—'}`,
        ]),
        'browser',
      )}<details><summary>Reported user agents</summary>${table(
        ['Browser ID', 'Received (UTC)', 'User agent'],
        stats.modelErrors.map((row) => [
          row.player,
          row.at,
          row.userAgent || '—',
        ]),
        'browser',
      )}</details><p>Up to 200 groups and the latest 200 errors are shown. Group counts cover all matching errors, not just the latest 200.</p>`
    : ''
}
${
  stats.browser
    ? `<h2>Browser ${escape(stats.browser.id.slice(0, 8))}</h2>
<p>First seen ${escape(stats.browser.firstDay)} · ${escape(stats.browser.visits)} visits · ${escape(stats.browser.practiceRounds)} practice rounds · ${escape(stats.browser.wins)} wins · ${escape(stats.browser.losses)} losses · ${escape(stats.browser.writeins)} write-ins / ${escape(stats.browser.guesses)} guesses</p>
<p>Settings / displayed themes: ${escape(stats.browser.themes || 'Not yet recorded')}</p>
<p>IP addresses: ${stats.browser.addresses.map(({ id }) => link('ip', id)).join(', ') || 'None recorded yet'}.</p>
${history(stats.browser.history)}
<p>Latest 200 completed rounds. Detailed browser history starts with this release; older aggregate totals remain available.</p>`
    : ''
}
${
  stats.ip
    ? `<h2>IP ${escape(stats.ip.id)}</h2>
<p>First seen ${escape(stats.ip.firstDay)} · last seen ${escape(stats.ip.lastDay)} · ${escape(stats.ip.browserCount)} browsers · ${escape(stats.ip.visits)} visits · ${escape(stats.ip.practiceRounds)} practice rounds · ${escape(stats.ip.wins)} wins · ${escape(stats.ip.losses)} losses · ${escape(stats.ip.writeins)} write-ins / ${escape(stats.ip.guesses)} guesses</p>
<p>Settings / displayed themes: ${escape(stats.ip.themes || 'Not yet recorded')}</p>
<h3>Browsers seen at this IP</h3>${browsers(stats.ip.browsers)}
<h3>Completed rounds at this IP</h3>${history(stats.ip.history, true)}
<p>Up to 200 browsers and the latest 200 completed rounds across days. Only events received from this address are included.</p>
<details><summary>Game and model counters at this IP on ${escape(stats.day)}</summary>${counters(stats.ip.counters)}</details>`
    : ''
}
<h2>IP addresses on this day</h2>${table(
      [
        'IP address',
        'Browsers',
        'Setting / theme',
        'Visits',
        'Practice rounds',
        'Wins',
        'Losses',
        'Write-ins',
        'Guesses',
      ],
      stats.ips.map((row) => [
        row.id,
        row.browserCount,
        row.themes || '—',
        row.visits,
        row.practiceRounds,
        row.wins,
        row.losses,
        row.writeins,
        row.guesses,
      ]),
      'ip',
    )}
<p>Select an IP to view its activity across days. Up to 200 addresses are shown. IP tracking starts with this update; earlier events have no IP association.</p>
<h2>Browsers on this day</h2>${browsers(stats.browsers)}
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
<details><summary>All game and model counters</summary>${counters(stats.counters)}</details></html>`,
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
