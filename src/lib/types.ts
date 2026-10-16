export type Band = 0 | 50 | 90 | 95 | 99 | 99.9
export type Mode = 'daily' | 'practice'

export interface TokenActivation {
  id: number
  start: number
  end: number
  activation: number
}

export interface Passage {
  id: string
  text: string
  before: string
  after: string
  source: { title: string; url: string; license: string }
  band: Band
  tokens: TokenActivation[]
}

export interface Feature {
  id: string
  kind: 'sae' | 'neuron'
  index: number
  title: string
  description: string
  reference: number[]
  displayScale: number
  starter: Passage
  passages: Passage[]
  encoder?: { weight: number[]; bias: number; threshold: number }
}

export interface Catalog {
  version: string
  firstDay: string
  daily: Record<string, string>
  practice: string[]
  browserModel?: { manifest: string; bytes: number }
}

export interface Guess {
  kind: 'passage' | 'custom'
  passageId?: string
  text: string
  tokens: TokenActivation[]
  rawMax: number
  score: number
}

export interface Game {
  version: 2
  mode: Mode
  seed: string
  featureId: string
  guesses: Guess[]
}
