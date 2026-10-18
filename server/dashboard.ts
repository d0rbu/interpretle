import { ADMIN_HEADERS, escape as e } from './admin'
import type { ErrorSample, FlowGroup, Insights } from './insights'

const number = (n: number) => n.toLocaleString('en-US')
const percent = (n: number, total: number) =>
  total ? `${Math.round((n / total) * 100)}%` : '—'
const utc = (at: string) => at.replace('T', ' ').replace(/Z$/, ' UTC')
const colors = {
  blue: '#7097ed',
  green: '#65b897',
  red: '#e87f83',
  gray: '#9296a4',
  gold: '#d6ac64',
  purple: '#a88bd6',
}
const empty = (text = 'No activity in this window yet.') =>
  `<p class="empty">${e(text)}</p>`
const legend = (entries: [string, string][]) =>
  `<div class="legend">${entries.map(([label, color]) => `<span><i style="background:${color}"></i>${e(label)}</span>`).join('')}</div>`

function lineChart(
  data: Insights['series'],
  lines: {
    key: 'browsers' | 'games' | 'errors' | 'writeins'
    label: string
    color: string
  }[],
) {
  const w = 760,
    h = 225,
    left = 42,
    top = 18,
    bottom = 192
  const maximum = Math.max(
    1,
    ...data.flatMap((row) => lines.map(({ key }) => row[key])),
  )
  const ceiling = Math.ceil(maximum / 4) * 4
  const x = (i: number) =>
    left + (w - left - 18) * (data.length === 1 ? 0.5 : i / (data.length - 1))
  const y = (value: number) => bottom - (value / ceiling) * (bottom - top)
  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = (ceiling * i) / 4
    return `<line class="gridline" x1="${left}" y1="${y(value)}" x2="${w - 18}" y2="${y(value)}"/><text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${number(value)}</text>`
  }).join('')
  const stride = Math.max(1, Math.ceil(data.length / 6))
  const dates = data
    .map((row, i) =>
      i % stride === 0 || i === data.length - 1
        ? `<text x="${x(i)}" y="216" text-anchor="middle">${e(row.day.slice(5).replace('-', '/'))}</text>`
        : '',
    )
    .join('')
  return `${legend(lines.map(({ label, color }) => [label, color]))}<div class="chart-scroll"><svg class="plot" viewBox="0 0 ${w} ${h}" role="img" aria-label="${e(lines.map((line) => line.label).join(' and '))} by Pacific day">${grid}${dates}${lines.map(({ key, label, color }) => `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${data.map((row, i) => `${x(i)},${y(row[key])}`).join(' ')}"/>${data.map((row, i) => `<circle tabindex="0" cx="${x(i)}" cy="${y(row[key])}" r="3.5" fill="${color}" aria-label="${e(`${row.day}: ${number(row[key])} ${label}`)}"><title>${e(`${row.day} · ${label}: ${number(row[key])}`)}</title></circle>`).join('')}`).join('')}</svg></div>`
}

function bars(
  rows: { label: string; count: number; color?: string }[],
  color = colors.blue,
  share = false,
) {
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (!total) return empty()
  const maximum = Math.max(...rows.map((row) => row.count), 1)
  return `<div class="bars">${rows.map((row, index) => `<div class="bar-row"><span class="bar-label">${e(row.label)}</span><div class="bar-track"><div style="width:${(row.count / maximum) * 100}%;background:${row.color ?? (share ? [colors.blue, colors.purple, colors.gold, colors.green][index % 4] : color)}"></div></div><span class="bar-value">${number(row.count)}${share ? `<small>${percent(row.count, total)}</small>` : ''}</span></div>`).join('')}</div>`
}

export function flowSteps(groups: FlowGroup[]) {
  const included = groups.filter((group) => group.fromStart)
  const total = included.reduce((sum, group) => sum + group.count, 0)
  const maximum = Math.max(6, ...included.map((group) => group.limit))
  return {
    total,
    skipped: groups
      .filter((group) => !group.fromStart)
      .reduce((sum, group) => sum + group.count, 0),
    steps: Array.from({ length: maximum + 1 }, (_, guess) => {
      const count = (filter: (group: FlowGroup) => boolean) =>
        included.filter(filter).reduce((sum, group) => sum + group.count, 0)
      return {
        guess,
        reached: count((group) => group.guesses >= guess),
        next: count((group) => group.guesses > guess),
        won: count(
          (group) => group.guesses === guess && group.outcome === 'won',
        ),
        lost: count(
          (group) => group.guesses === guess && group.outcome === 'lost',
        ),
        open: count(
          (group) => group.guesses === guess && group.outcome === 'open',
        ),
      }
    }),
  }
}

function sankey(groups: FlowGroup[]) {
  const flow = flowSteps(groups)
  if (!flow.total)
    return empty(
      'Newly recorded games will appear here as players open a puzzle. Older aggregate counters cannot reconstruct these paths.',
    )
  const sum = (key: 'won' | 'lost' | 'open') =>
    flow.steps.reduce((n, step) => n + step[key], 0)
  const won = sum('won'),
    lost = sum('lost'),
    open = sum('open')
  const scale = 140 / flow.total,
    width = 1120,
    sinkX = 945
  const spacing = (sinkX - 95) / flow.steps.length
  const nodeY = (n: number) => 190 - (n * scale) / 2
  const sinkY = { won: 20, open: 305, lost: 345 + open * scale }
  const offsets = { won: 0, open: 0, lost: 0 }
  const ribbons: string[] = [],
    nodes: string[] = []
  const ribbon = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    count: number,
    color: string,
    title: string,
  ) => {
    if (!count) return
    const h = count * scale,
      control = (x1 + x2) / 2
    ribbons.push(
      `<path d="M${x1},${y1} C${control},${y1} ${control},${y2} ${x2},${y2} L${x2},${y2 + h} C${control},${y2 + h} ${control},${y1 + h} ${x1},${y1 + h} Z" fill="${color}" fill-opacity=".24" tabindex="0" aria-label="${e(title)}"><title>${e(title)}</title></path>`,
    )
  }
  for (const step of flow.steps) {
    const x = 28 + step.guess * spacing,
      y = nodeY(step.reached)
    const label = step.guess ? `Guess ${step.guess}` : 'Opened'
    nodes.push(
      `<text x="${x + 6}" y="94" text-anchor="middle" class="node-label">${label}</text><text x="${x + 6}" y="113" text-anchor="middle">${number(step.reached)}</text>${step.reached ? `<rect x="${x}" y="${y}" width="12" height="${step.reached * scale}" rx="3" fill="${colors.blue}"><title>${e(`${label}: ${step.reached} games`)}</title></rect>` : ''}`,
    )
    let offset = 0
    for (const key of ['won', 'next', 'open', 'lost'] as const) {
      const count = step[key]
      if (key === 'next') {
        ribbon(
          x + 12,
          y + offset,
          x + spacing,
          nodeY(count),
          count,
          colors.blue,
          `${number(count)} games continued to guess ${step.guess + 1}`,
        )
      } else {
        ribbon(
          x + 12,
          y + offset,
          sinkX,
          sinkY[key] + offsets[key],
          count,
          key === 'won'
            ? colors.green
            : key === 'lost'
              ? colors.red
              : colors.gray,
          `${number(count)} games ${key === 'won' ? 'solved' : key === 'lost' ? 'used every attempt' : 'remain unfinished'} ${step.guess ? `at guess ${step.guess}` : 'before guessing'}`,
        )
        offsets[key] += count * scale
      }
      offset += count * scale
    }
  }
  for (const [key, label, count, color] of [
    ['won', 'Solved', won, colors.green],
    ['open', 'Unfinished', open, colors.gray],
    ['lost', 'Out of attempts', lost, colors.red],
  ] as const) {
    const y = sinkY[key],
      h = count * scale
    nodes.push(
      `<rect x="${sinkX}" y="${y}" width="12" height="${Math.max(1, h)}" rx="3" fill="${color}"/><text x="${sinkX + 24}" y="${y + Math.max(4, h / 2) - 2}" class="node-label">${label}</text><text x="${sinkX + 24}" y="${y + Math.max(4, h / 2) + 17}">${number(count)} · ${percent(count, flow.total)}</text>`,
    )
  }
  return `${legend([
    ['Continued', colors.blue],
    ['Solved', colors.green],
    ['Unfinished', colors.gray],
    ['Out of attempts', colors.red],
  ])}<p class="scroll-hint">Scroll sideways to follow every guess →</p><div class="chart-scroll flow"><svg viewBox="0 0 ${width} ${Math.max(440, sinkY.lost + lost * scale + 35)}" role="img" aria-label="Game progression: ${flow.total} opened, ${won} solved, ${open} unfinished, ${lost} out of attempts">${ribbons.join('')}${nodes.join('')}</svg></div><p class="note">One path per browser and puzzle. Unfinished means no result has arrived yet. ${flow.skipped ? `${number(flow.skipped)} restored or partial histories are excluded because their opening state was not recorded.` : 'Only games with a recorded opening state are included.'}</p>`
}

function rawLink(sample: ErrorSample, game = false) {
  const params = new URLSearchParams({ browser: sample.player })
  const detail = sample.details
  if (game && detail.mode && detail.round && detail.feature) {
    params.set('mode', detail.mode)
    params.set('round', detail.round)
    params.set('feature', detail.feature)
  }
  return '/admin/raw?' + e(params.toString())
}

function errorSample(sample: ErrorSample) {
  const d = sample.details,
    report = d.report
  const facts = [
    ['Browser', d.browser],
    ['System', `${d.os} · ${d.device}`],
    ['Backend', d.backend],
    ['Stage', report?.stage ?? d.phase],
    ['Build', report?.release],
    ['GPU adapter', report?.gpu],
    ['Model manifest', report?.manifest],
    ['Model tokens', report?.tokens],
    ['WASM threads', report?.threads],
    ['Logical cores', d.cores],
    ['Reported RAM', d.memoryGb === undefined ? undefined : `${d.memoryGb} GB`],
    [
      'Online / visible / isolated',
      report
        ? `${report.online ?? '?'} / ${report.visible ?? '?'} / ${report.isolated ?? '?'}`
        : undefined,
    ],
    [
      'Operation duration',
      report?.elapsedMs === undefined
        ? undefined
        : `${(report.elapsedMs / 1000).toFixed(1)} s`,
    ],
    ['Browser timestamp', d.clientAt && utc(d.clientAt)],
    ['Received', utc(sample.at)],
  ].filter(([, value]) => value !== undefined && value !== '')
  return `<div class="incident"><div class="incident-head"><span>${e(utc(sample.at))}</span><a href="${rawLink(sample, true)}">Open game / browser history ↗</a></div><dl class="facts">${facts.map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>${report ? `<h3>Original exception</h3><pre>${e(report.stack || `${report.name}: ${report.message}`)}${report.filename ? `\n${e(report.filename)}:${report.line ?? '?'}:${report.column ?? '?'}` : ''}</pre>${report.captureStack ? `<h3>Capture location · original stack unavailable</h3><pre>${e(report.captureStack)}</pre>` : ''}${report.cause ? `<h3>Caused by</h3><pre>${e(report.cause)}</pre>` : ''}${report.trail?.length ? `<h3>Events leading up to the failure</h3><ol class="breadcrumbs">${report.trail.map(({ at, stage }) => `<li><time datetime="${e(at)}">${e(at.slice(11, 23))}</time><span>${e(stage)}</span></li>`).join('')}</ol>` : ''}` : `<p class="note">This older event did not include the original exception or stack trace.</p>`}</div>`
}

function issues(data: Insights) {
  if (!data.issues.length)
    return empty(
      data.series.some((row) => row.errors)
        ? 'Older errors were counted without diagnostic reports. New exceptions will appear here with their original stack and context.'
        : 'No errors recorded in this window.',
    )
  return data.issues
    .map((issue) => {
      const d = issue.samples[0].details,
        report = d.report
      return `<details class="issue"><summary><span class="issue-count">${number(issue.count)}<small>events</small></span><span class="issue-title"><strong>${e(report ? `${report.name}: ${report.message}` : `${d.code} · ${d.phase}`)}</strong><span>${e(report?.stage ?? d.phase)} · ${e(d.backend)} · ${number(issue.players)} ${issue.players === 1 ? 'browser' : 'browsers'}</span></span><span class="issue-time">Last seen<time datetime="${e(issue.lastAt)}">${e(utc(issue.lastAt))}</time></span></summary><div class="issue-body"><p class="note">First seen ${e(utc(issue.firstAt))} · ${report ? `Issue ${e(issue.issue.slice(0, 12))}` : 'Legacy report'} · Latest ${issue.samples.length} ${issue.samples.length === 1 ? 'occurrence' : 'occurrences'} shown</p>${issue.samples.map((sample, i) => (i ? `<details class="occurrence"><summary>${e(utc(sample.at))} · ${e(sample.details.browser)} · ${e(sample.details.os)}</summary>${errorSample(sample)}</details>` : errorSample(sample))).join('')}</div></details>`
    })
    .join('')
}

export async function dashboardPage(response: Response) {
  if (!response.ok) return response
  const data: Insights = await response.json()
  const total = (
    key:
      | 'visits'
      | 'games'
      | 'wins'
      | 'losses'
      | 'errors'
      | 'guesses'
      | 'writeins',
  ) => data.series.reduce((sum, row) => sum + row[key], 0)
  const raw = '/admin/raw?day=' + e(data.end)
  const metrics = [
    [
      'Browsers',
      number(data.people.browsers),
      `${number(data.people.returning)} seen on an earlier day`,
    ],
    ['Visits', number(total('visits')), 'All visits, including repeat visits'],
    [
      'Games started',
      number(total('games')),
      'First successful guess in a game',
    ],
    [
      'Games solved',
      number(total('wins')),
      `${percent(total('wins'), total('wins') + total('losses'))} of completed games`,
    ],
    [
      'Write-in share',
      percent(total('writeins'), total('guesses')),
      `${number(total('writeins'))} of ${number(total('guesses'))} scored guesses`,
    ],
    [
      'Errors',
      number(total('errors')),
      `${number(data.coverage.exceptions)} with original exceptions`,
    ],
  ]
  const wins = data.attempts.map((row) => ({
    ...row,
    label: `Guess ${row.label}`,
    color: colors.green,
  }))
  const losses = data.outcomes.find((row) => row.label === 'lost')?.count ?? 0
  if (losses)
    wins.push({ label: 'X · Failed', count: losses, color: colors.red })
  const modeName =
    data.mode === 'all'
      ? 'Daily + practice'
      : data.mode === 'daily'
        ? 'Daily'
        : 'Practice'
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Analytics · interpretle</title><style>${styles}</style></head><body><main>
<header><a class="brand" href="/admin"><i aria-hidden="true"></i>interpretle<span>analytics</span></a><nav aria-label="Admin"><a href="${raw}">Raw data ↗</a><a href="/">Open game ↗</a></nav></header>
<section class="page-heading"><div><span class="eyebrow">Private dashboard</span><h1>Game overview</h1><p>How people play, where they stop, and what breaks.</p></div><form action="/admin"><label>Ending on<input type="date" name="day" value="${e(data.end)}"></label><label>Window<select name="days">${[1, 7, 14, 30, 90].map((n) => `<option value="${n}"${n === data.days ? ' selected' : ''}>${n === 1 ? 'One day' : `${n} days`}</option>`).join('')}</select></label><label>Games<select name="game">${[
      ['all', 'Daily + practice'],
      ['daily', 'Daily'],
      ['practice', 'Practice'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === data.mode ? ' selected' : ''}>${label}</option>`,
      )
      .join('')}</select></label><button>Apply</button></form></section>
<div class="range-note">${e(data.start)} – ${e(data.end)} · Pacific days · ${modeName} <span>Audience and errors include all modes.</span></div>
<section class="metrics" aria-label="Key metrics">${metrics.map(([label, value, note]) => `<article><h2>${label}</h2><div>${value}</div><p>${e(note)}</p></article>`).join('')}</section>
<div class="grid"><section class="panel"><div class="panel-head"><div><h2>Audience & play</h2><p>Daily browsers and games started</p></div><span class="tag">Over time</span></div>${lineChart(
      data.series,
      [
        { key: 'browsers', label: 'Browsers', color: colors.blue },
        { key: 'games', label: 'Games started', color: colors.purple },
      ],
    )}</section>
<section class="panel"><div class="panel-head"><div><h2>Write-ins & errors</h2><p>Successful custom guesses and reported failures</p></div></div>${lineChart(
      data.series,
      [
        { key: 'writeins', label: 'Scored write-ins', color: colors.green },
        { key: 'errors', label: 'Errors · all modes', color: colors.red },
      ],
    )}</section>
<section class="panel wide"><div class="panel-head"><div><h2>From opening the puzzle to the final guess</h2><p>Follow the ribbons to see how games progress</p></div><span class="tag">${modeName}</span></div>${sankey(data.flow)}</section>
<section class="panel"><div class="panel-head"><div><h2>When games end</h2><p>Winning guess, or every attempt used</p></div></div>${bars(wins, colors.green)}<p class="note">Completed results in this window. Unfinished games appear in the flow above.</p></section>
<section class="panel"><div class="panel-head"><div><h2>Which options get picked</h2><p>Suggested positions versus scored write-ins</p></div></div>${bars(data.slots, colors.purple)}<p class="note">Scored guesses, including repeated positions in later turns.</p></section>
<section class="panel wide" id="errors"><div class="panel-head"><div><h2>Exceptions & failures</h2><p>Grouped issues, original stacks and the steps before failure</p></div><a href="${raw}#model-errors">All records ↗</a></div><p class="note">${number(total('errors'))} error events · ${number(data.coverage.errorRecords)} diagnostic records · ${number(data.coverage.exceptions)} original exceptions. Older events cannot be reconstructed into stack traces. Expand an issue to investigate.</p>${issues(data)}</section>
<section class="panel"><div class="panel-head"><div><h2>Practice rounds per browser</h2><p>Repeat play during the selected window</p></div></div>${bars(data.practice, colors.blue)}<p class="note">Includes browsers with no practice rounds.</p></section>
<section class="panel"><div class="panel-head"><div><h2>Appearance preferences</h2><p>Selected setting / displayed theme</p></div></div>${bars(data.themes, colors.purple, true)}<p class="note">A visit can use more than one setting. These are setting observations, not unique people.</p></section>
<section class="panel wide"><div class="panel-head"><div><h2>Devices</h2><p>Browser-reported device type on recorded visits</p></div></div>${bars(data.devices, colors.gold, true)}<p class="note">Device detail and game flows start ${data.coverage.historySince ? e(utc(data.coverage.historySince)) : 'with the new event history'}. Earlier aggregate traffic remains in the charts above.</p></section></div>
<footer>Private, first-party analytics. Browser IDs and IPs are not unique people. Times are server receipts unless labeled otherwise. <a href="${raw}">Explore individual games and exports ↗</a></footer>
</main></body></html>`,
    { headers: ADMIN_HEADERS },
  )
}

const styles = `
:root{color-scheme:light dark;--bg:#f5f6f8;--panel:#fff;--text:#222938;--muted:#687286;--line:#e4e7ed;--soft:#f4f6fa;--accent:#446ba9;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#11151d;--panel:#191e29;--text:#e8ebf2;--muted:#99a4b7;--line:#2a3242;--soft:#222938;--accent:#9ab9f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{max-width:1400px;margin:auto;padding:0 36px 32px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:4px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:25px 0;border-bottom:1px solid var(--line)}.brand{font-size:23px;font-weight:720;color:var(--text);display:flex;align-items:center;gap:9px;letter-spacing:-.8px}.brand i{width:18px;height:18px;border-radius:5px;background:#75b59b;box-shadow:inset 0 0 0 1px #ffffff30}.brand span{font-size:12px;letter-spacing:.02em;font-weight:500;color:var(--muted);margin-left:7px;border-left:1px solid var(--line);padding-left:14px}nav{display:flex;gap:22px;font-size:13px}.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:35px 0 16px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:30px;letter-spacing:-1px;line-height:1.2;margin:7px 0 8px}p{color:var(--muted);margin:0}.page-heading p{font-size:14px}form{display:flex;gap:9px;align-items:end;flex-wrap:wrap}label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:11px;font-weight:600}input,select,button{height:36px;border:1px solid var(--line);border-radius:7px;padding:6px 10px;background:var(--panel);font:13px system-ui;color:var(--text)}button{background:var(--text);color:var(--panel);border-color:var(--text);padding-inline:17px;cursor:pointer}.range-note{font-size:12px;color:var(--muted);display:flex;gap:20px;flex-wrap:wrap;margin:0 0 21px}.range-note span{margin-left:auto}.metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:20px}.metrics article{padding:18px 16px;background:var(--panel);border:1px solid var(--line);border-radius:11px}.metrics h2{font-size:12px;font-weight:550;color:var(--muted);margin:0 0 8px}.metrics article>div{font-size:28px;line-height:1.1;letter-spacing:-.8px;font-weight:650;font-variant-numeric:tabular-nums}.metrics p{font-size:10px;margin:8px 0 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.panel{padding:23px 24px;background:var(--panel);border:1px solid var(--line);border-radius:12px;min-width:0}.wide{grid-column:1/-1}.panel-head{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:17px}.panel h2{font-size:16px;font-weight:650;letter-spacing:-.2px;margin:0 0 4px}.panel-head p{font-size:12px}.panel-head>a{font-size:12px;white-space:nowrap}.tag{border:1px solid var(--line);border-radius:6px;padding:3px 8px;color:var(--muted);font-size:10px;white-space:nowrap}.scroll-hint{display:none;font-size:10px;margin:0 0 12px}.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:10px}.legend span{display:flex;align-items:center;gap:6px}.legend i{display:inline-block;width:8px;height:8px;border-radius:3px}.chart-scroll{overflow-x:auto;overscroll-behavior-x:contain}svg{display:block;width:100%;height:auto;font:11px system-ui;overflow:visible}svg text{fill:var(--muted)}.plot{min-width:380px}.gridline{stroke:var(--line);stroke-dasharray:3 5;stroke-width:1}circle:focus,circle:hover{r:6;outline:none}.flow svg{min-width:900px}.flow path:hover,.flow path:focus{fill-opacity:.65;outline:none}.node-label{font-size:12px;font-weight:650;fill:var(--text)}.note{font-size:11px;line-height:1.65;margin-top:17px}.bars{display:flex;flex-direction:column;gap:12px;margin:23px 0}.bar-row{display:grid;grid-template-columns:116px 1fr 68px;align-items:center;gap:12px;min-height:22px}.bar-label{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.bar-track{height:9px;background:var(--soft);border-radius:4px;overflow:hidden}.bar-track>div{height:100%;border-radius:4px}.bar-value{font-size:12px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.bar-value small{font-size:10px;font-weight:400;color:var(--muted);margin-left:8px}.empty{font-size:13px;padding:48px 24px;text-align:center;background:var(--soft);border-radius:8px;margin:15px 0}.issue{border-top:1px solid var(--line)}.issue:first-of-type{margin-top:20px}.issue>summary{display:flex;gap:18px;align-items:center;cursor:pointer;padding:18px 0;list-style:none}.issue>summary::-webkit-details-marker,.occurrence>summary::-webkit-details-marker{display:none}.issue>summary::after{content:'⌄';font-size:20px;color:var(--muted);margin-left:2px}.issue[open]>summary::after{transform:rotate(180deg)}.issue-count{flex:none;text-align:center;border:1px solid var(--line);border-radius:8px;min-width:55px;padding:7px;font-size:18px;font-weight:600;line-height:1.2}.issue-count small{display:block;font-weight:400;font-size:10px;color:var(--muted);margin-top:2px}.issue-title{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}.issue-title strong{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.issue-title>span{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.issue-time{font-size:10px;color:var(--muted);text-align:right}.issue-time time{display:block;font-variant-numeric:tabular-nums}.issue-body{padding:0 0 20px 73px}.issue-body>.note{margin:0 0 14px}.incident{background:var(--soft);border:1px solid var(--line);border-radius:9px;padding:18px;margin-top:12px;min-width:0}.incident-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted);padding-bottom:12px;border-bottom:1px solid var(--line)}.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px 20px;margin:16px 0}.facts div{min-width:0}.facts dt{font-size:10px;color:var(--muted)}.facts dd{margin:2px 0 0;font-size:11px;overflow-wrap:anywhere}h3{font-size:11px;margin:20px 0 8px;font-weight:650}pre{font:11px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel);padding:14px;border-radius:7px;margin:0;max-height:330px;overflow:auto}.breadcrumbs{list-style:none;padding:0;margin:0;max-height:245px;overflow:auto}.breadcrumbs li{display:flex;gap:16px;border-bottom:1px solid var(--line);padding:7px 0;font-size:11px}.breadcrumbs time{font-family:ui-monospace,monospace;color:var(--muted);flex:none}.occurrence{margin-top:16px}.occurrence>summary{cursor:pointer;color:var(--accent);font-size:11px;list-style:none}.occurrence>summary::before{content:'⌄';margin-right:8px}footer{margin-top:26px;padding-top:20px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.8}footer a{display:inline-block;margin-left:8px}
@media(max-width:1100px){.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.page-heading{align-items:start;flex-direction:column;gap:18px}.range-note span{margin-left:0}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){main{padding:0 16px 24px}header{padding:20px 0;gap:12px}.brand{font-size:20px}.brand span{display:none}nav{gap:14px;font-size:11px}.page-heading{padding:26px 0 16px}h1{font-size:26px}form{gap:8px}input,select{max-width:142px}label{font-size:10px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metrics article{padding:15px}.metrics article>div{font-size:25px}.grid{grid-template-columns:1fr;gap:14px}.panel{padding:19px 16px}.wide{grid-column:auto}.scroll-hint{display:block}.bar-row{grid-template-columns:108px 1fr 60px;gap:8px}.issue>summary{gap:10px}.issue-time{display:none}.issue-body{padding-left:0}.issue-count{min-width:44px}.facts{gap:12px}.incident{padding:12px}.issue-title strong{font-size:12px}.panel-head{gap:10px}.panel-head>a{font-size:11px}}
`
