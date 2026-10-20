export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** How a tier was chosen: a local rule, the judge model, laya-serve, a `!tier` prefix, a short follow-up. */
export type Source = 'rule' | 'judge' | 'laya' | 'forced' | 'follow-up' | 'escalated' | 'crew'

/** The model and effort the main loop runs on, and why. */
export type Route = {
  tier: Tier
  model: string
  effort: Effort
  source: Source
  confidence: number
}

/** Output shape the system prompt asks for. */
export type Style = 'off' | 'terse' | 'adhd'

/** What a model's prompt cache holds: the context it last read, and when. */
export type Warm = Record<string, { tokens: number; at: number }>

/** Money and tokens, for /router. Dollars are estimates from list prices. */
export type Ledger = {
  /** Main-loop turns per tier. */
  turns: Record<Tier, number>
  /** Steps the router moved off the model they would have run on. */
  routedSteps: number
  /** What those steps cost on the routed model. */
  actualUsd: number
  /** What the same steps would have cost on the model they would have run on. */
  baselineUsd: number
  /** Re-routes the cost model allowed, and the ones it refused because the cache was worth more. */
  switches: number
  holds: number
  judgeCalls: number
  judgeUsd: number
  /** Bash results compressed, and their size before and after, in characters. */
  compressions: number
  rawChars: number
  keptChars: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: Route | null
      /** The session's /model when routing began; a different one later means the person took over. */
      sessionModel: string | null
      isManual: boolean
      /** A typed skill command waiting for its expanded text before it is routed. */
      pending: string | null
      /** Input tokens the last main-loop request carried. */
      context: number
      warm: Warm
      /** Main-loop steps of the turn in progress. */
      steps: number
      /** Failed or repeated main-loop tool calls in a row. */
      strikes: number
      lastCall: string | null
      /** The turn already escalated once (or nudged, under `escalate: suggest`). */
      hasEscalated: boolean
      /** /router style for this session; null follows the `style` option. */
      style: Style | null
      ledger: Ledger
      /** The line shown beneath the turn's answer. */
      note: string | null
    }
  }
}
