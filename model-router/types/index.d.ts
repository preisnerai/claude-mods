export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

/** `Tier` under a name the engine's own module does not use (inside `declare module 'claude-code'`, `Tier` is the engine's). */
export type ModelTier = Tier

/** What the router sends. Never `max` or `ultracode`: those are the person's own call in Desktop. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

/** How a tier was chosen: a local rule, the judge model, laya-serve, a `!tier` prefix, a short follow-up. */
export type Source = 'rule' | 'judge' | 'laya' | 'forced' | 'follow-up' | 'escalated' | 'crew'

/** The model and effort the main loop runs on, and why. */
export type Route = {
  tier: Tier
  model: string
  effort: Effort
  source: Source
  confidence: number
  /** On the session's own model: send this effort instead of the session's (the cache math allowed it). */
  setsEffort?: boolean
}

/** Output shape the system prompt asks for. */
export type Style = 'off' | 'terse' | 'adhd'

/** What a model's prompt cache holds: the context it last read, and when. */
export type Warm = Record<string, { tokens: number; at: number }>

/** Money and tokens, for /router. Dollars are estimates from list prices. */
export type Ledger = {
  /** Main-loop turns per tier. */
  turns: Record<Tier, number>
  /** Requests the router sent to another model than the session's own (crew workers included). */
  routedSteps: number
  /** What the session's requests cost. */
  actualUsd: number
  /** What the same requests would have cost on the session's own model, with that model's own cache. */
  baselineUsd: number
  /** Re-routes the cost model allowed, and the ones it refused because the cache was worth more. */
  switches: number
  holds: number
  judgeCalls: number
  judgeUsd: number
  /** Prompt-cache traffic: tokens read from cache, written to cache, and sent uncached. */
  cacheReadTokens: number
  cacheWriteTokens: number
  uncachedInputTokens: number
  /** Requests that read any cache vs. wrote a cache entry without a read. */
  cacheHits: number
  cacheMisses: number
  /** Bash results compressed, and their size before and after, in characters. */
  compressions: number
  rawChars: number
  keptChars: number
}

/** What a request was sent with. */
export type Sent = { model: string; effort: string | number | null }

/** A prompt typed while a turn ran, routed when its own turn starts. */
export type Queued = { text: string; tier: Tier | null; why?: string; nudge?: number }

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      route: Route | null
      /** The session's /model when routing began; a different one later means the person took over. */
      sessionModel: string | null
      isManual: boolean
      /** Prompts typed during a running turn, routed when their turn starts. */
      queued: Queued[]
      /** Input tokens the last main-loop request carried, plus its answer. */
      context: number
      /** Input tokens of the session's first request: the system prompt and tools, cached for every conversation. */
      prefix: number
      warm: Warm
      /** What the last main-loop request was sent with, and the session's own effort before any rewrite. */
      lastSent: Sent | null
      baseEffort: string | number | null
      /** The session model's cache as if every request had gone there: the baseline the savings are measured against. */
      shadow: { tokens: number; at: number } | null
      /** The task tier of the turn in progress, which its finished shape is learned into. */
      taskTier: ModelTier | null
      /** Main-loop requests of the turn in progress, and the prompt sizes of its first and last. */
      steps: number
      turnFirst: number
      turnLast: number
      /** Failed or repeated main-loop tool calls in a row. */
      strikes: number
      lastCall: string | null
      /** The turn already escalated once (or nudged, under `escalate: suggest`). */
      hasEscalated: boolean
      /** /router style for this session; null follows the `style` option. */
      style: Style | null
      ledger: Ledger
      /** A session budget in USD; null follows the `budgetUsd` option, 0 is off. */
      budget: number | null
      /** Crew workers by agent id, and the prompt size of each one's last and first request. */
      workers: string[]
      workerWarm: Record<string, { tokens: number; at: number; first: number }>
      /** The line shown beneath the turn's answer. */
      note: string | null
      /** What the routed task is learned under (its rule, or judge/laya), for corrections that follow it. */
      category: string | null
      paneAsked: boolean
    }
  }
}
