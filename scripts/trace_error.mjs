// Decode a private /admin/raw JSON export with the exact build's local maps.
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  TraceMap,
  originalPositionFor,
  sourceContentFor,
} from '@jridgewell/trace-mapping'

const file = process.argv[2]
if (!file)
  throw new Error(
    'Usage: npm run errors:trace -- /path/to/private-event-export.json',
  )
const reports = []
function collect(value) {
  if (!value || typeof value !== 'object') return
  if (value.report?.release) reports.push(value.report)
  else if (value.release && value.source && value.message) reports.push(value)
  for (const [key, child] of Object.entries(value))
    if (key !== 'report') collect(child)
}
collect(JSON.parse(await readFile(file, 'utf8')))
if (!reports.length) throw new Error('No exception reports in this export.')
for (const report of reports) {
  if (!/^[a-z0-9][\w.-]{0,99}$/i.test(report.release))
    throw new Error('Invalid build ID.')
  console.log(
    `\n${report.name}: ${report.message}\n${report.stage} · ${report.release}`,
  )
  if (!report.stack)
    console.log('Original stack unavailable; showing the capture location.')
  const stack = [
    report.stack || report.captureStack || '',
    `${report.filename ?? ''}:${report.line ?? 0}:${report.column ?? 0}`,
  ].join('\n')
  for (const line of stack.split('\n')) {
    console.log(line)
    const frame = /((?:https?:\/\/|\/assets\/)[^\s)]+):(\d+):(\d+)/.exec(line)
    if (!frame) continue
    const name = basename(new URL(frame[1], 'https://interpretle.com').pathname)
    let map
    try {
      map = new TraceMap(
        JSON.parse(
          await readFile(
            join('artifacts/releases', report.release, 'assets', name + '.map'),
            'utf8',
          ),
        ),
      )
    } catch {
      console.log('  Source map unavailable for this frame/build.')
      continue
    }
    const original = originalPositionFor(map, {
      line: Number(frame[2]),
      column: Math.max(0, Number(frame[3]) - 1),
    })
    if (!original.source || !original.line) continue
    console.log(
      `  → ${original.source}:${original.line}:${(original.column ?? 0) + 1}${original.name ? ` (${original.name})` : ''}`,
    )
    const source = sourceContentFor(map, original.source, true)?.split('\n')
    for (
      let i = Math.max(0, original.line - 3);
      source && i < Math.min(source.length, original.line + 2);
      i++
    )
      console.log(
        `  ${i + 1 === original.line ? '>' : ' '} ${String(i + 1).padStart(4)}  ${source[i]}`,
      )
  }
}
