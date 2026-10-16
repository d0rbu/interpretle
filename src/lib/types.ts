export type Band = 0 | 50 | 90 | 95 | 99 | 99.9
export type Mode = 'daily' | 'practice'

export interface TokenActivation {
  text: string
  activation: number
  percentile: number
}

export interface Passage {
  id: string
  text: string
  context: string
  band: Band
}

export interface Feature {
  id: string
  title: string
  description: string
  cue: RegExp
  starter: Passage
  passages: Passage[]
}

export interface Guess {
  kind: 'passage' | 'custom'
  passageId?: string
  text: string
  score: number
  tokens: TokenActivation[]
}

export interface Game {
  version: 1
  id: string
  seed: string
  mode: Mode
  featureId: string
  guesses: Guess[]
}
