import { appBuild } from './diagnostics'

export const PROFILE_KINDS = [
  'tokenize',
  'weights',
  'wait',
  'inputs',
  'compute',
  'readback',
  'activation',
] as const
export type ProfileStep = {
  kind: (typeof PROFILE_KINDS)[number]
  name: string
  startMs: number
  ms: number
  layer?: number
  readMs?: number
  decodeMs?: number
  bytes?: number
  failed?: boolean
}
export type ModelProfile = {
  version: 1
  startedAt: string
  release: string
  manifest: string
  backend: 'cpu' | 'gpu'
  threads: number
  run: number
  tokens: number
  status: 'running' | 'ok' | 'error' | 'cancelled'
  totalMs: number
  steps: ProfileStep[]
}
const milliseconds = (n: number) => Math.round(Math.max(0, n) * 100) / 100

/** Wall-clock spans, without GPU fences or copying activations for profiling.
 * Weight preparation can overlap computation; those spans must not be added. */
export class ForwardProfile {
  private start = performance.now()
  private steps: ProfileStep[] = []
  private startedAt = new Date().toISOString()
  tokens = 0
  constructor(
    private context: Pick<
      ModelProfile,
      'backend' | 'threads' | 'manifest' | 'run'
    >,
  ) {}

  record(
    kind: ProfileStep['kind'],
    name: string,
    start: number,
    layer?: number,
    extra: Pick<ProfileStep, 'readMs' | 'decodeMs' | 'bytes' | 'failed'> = {},
  ) {
    if (this.steps.length >= 512) return
    this.steps.push({
      kind,
      name,
      startMs: milliseconds(start - this.start),
      ms: milliseconds(performance.now() - start),
      ...(layer === undefined ? {} : { layer }),
      ...extra,
    })
  }

  async measure<T>(
    kind: ProfileStep['kind'],
    name: string,
    run: () => Promise<T> | T,
    layer?: number,
  ): Promise<T> {
    const start = performance.now()
    let failed = true
    try {
      const result = await run()
      failed = false
      return result
    } finally {
      this.record(kind, name, start, layer, failed ? { failed } : {})
    }
  }

  snapshot(status: ModelProfile['status']): ModelProfile {
    return {
      version: 1,
      startedAt: this.startedAt,
      release: appBuild,
      ...this.context,
      tokens: this.tokens,
      status,
      totalMs: milliseconds(performance.now() - this.start),
      steps: [...this.steps].sort((a, b) => a.startMs - b.startMs),
    }
  }
}

/** Keep the public ingestion endpoint bounded; timing detail stays private. */
export function validProfile(value: unknown): value is ModelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as ModelProfile
  const ms = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 604_800_000
  const text = (s: unknown, limit: number) =>
    typeof s === 'string' && s.length > 0 && s.length <= limit
  const integer = (n: unknown, max: number) =>
    Number.isInteger(n) && Number(n) >= 0 && Number(n) <= max
  return (
    Object.keys(p).every((key) =>
      [
        'version',
        'startedAt',
        'release',
        'manifest',
        'backend',
        'threads',
        'run',
        'tokens',
        'status',
        'totalMs',
        'steps',
      ].includes(key),
    ) &&
    p.version === 1 &&
    typeof p.startedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.startedAt) &&
    Number.isFinite(Date.parse(p.startedAt)) &&
    text(p.release, 100) &&
    text(p.manifest, 240) &&
    ['cpu', 'gpu'].includes(p.backend) &&
    integer(p.threads, 1024) &&
    p.threads > 0 &&
    integer(p.run, 1000000) &&
    p.run > 0 &&
    integer(p.tokens, 10000) &&
    ['ok', 'error', 'cancelled'].includes(p.status) &&
    ms(p.totalMs) &&
    Array.isArray(p.steps) &&
    p.steps.length <= 512 &&
    p.steps.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        !Array.isArray(s) &&
        Object.keys(s).every((key) =>
          [
            'kind',
            'name',
            'startMs',
            'ms',
            'layer',
            'readMs',
            'decodeMs',
            'bytes',
            'failed',
          ].includes(key),
        ) &&
        PROFILE_KINDS.includes(s.kind) &&
        text(s.name, 100) &&
        ms(s.startMs) &&
        ms(s.ms) &&
        s.startMs + s.ms <= p.totalMs + 1 &&
        (s.layer === undefined || integer(s.layer, 255)) &&
        (s.readMs === undefined || ms(s.readMs)) &&
        (s.decodeMs === undefined || ms(s.decodeMs)) &&
        (s.bytes === undefined || integer(s.bytes, 4_000_000_000)) &&
        (s.failed === undefined || typeof s.failed === 'boolean'),
    )
  )
}
