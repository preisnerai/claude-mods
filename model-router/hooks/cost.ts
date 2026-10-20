import type { ModelUsage } from 'claude-code'

import type { Ledger, Tier, Warm } from '../types'

/** List prices in USD per million tokens: uncached input, output, cache read. */
export type Price = { input: number; output: number; read: number }

// Anthropic first-party list prices (October 2026). Longest id first, so `claude-opus-5-5` wins over `claude-opus-5`.
const PRICES: [string, Price][] = (
  [
    ['claude-haiku-5-5', { input: 0.1, output: 0.5, read: 0.01 }],
    ['claude-sonnet-5-5', { input: 2, output: 10, read: 0.2 }],
    ['claude-opus-5-5', { input: 4, output: 20, read: 0.2 }],
    ['claude-fable-5-1', { input: 10, output: 50, read: 0.25 }],
    ['claude-mythos-5-1', { input: 10, output: 50, read: 0.25 }],
    ['claude-fable-5', { input: 10, output: 50, read: 1 }],
    ['claude-opus-5', { input: 5, output: 25, read: 0.5 }],
    ['claude-sonnet-5', { input: 2, output: 10, read: 0.2 }],
    ['claude-opus-4-8', { input: 5, output: 25, read: 0.5 }],
    ['claude-opus-4-7', { input: 5, output: 25, read: 0.5 }],
    ['claude-opus-4-6', { input: 5, output: 25, read: 0.5 }],
    ['claude-sonnet-4-6', { input: 3, output: 15, read: 0.3 }],
    ['claude-haiku-4-5', { input: 1, output: 5, read: 0.1 }],
  ] as [string, Price][]
).sort((a, b) => b[0].length - a[0].length)

const ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

/** What a cache write costs, as a multiple of the input price, and how long the entry lives. */
export type Cache = { write: number; ttlMs: number }

// Claude Code writes 1-hour entries (it reports them as ephemeral_1h_input_tokens): 2x input, kept an hour.
// A setup that writes 5-minute entries pays 1.25x for them.
export const CACHE: Record<'1h' | '5m', Cache> = {
  '1h': { write: 2, ttlMs: 60 * 60_000 },
  '5m': { write: 1.25, ttlMs: 5 * 60_000 },
}

/** One model's prompt cache, whatever variant of its id a request named (`claude-opus-5-5[1m]`). */
export function cacheKey(model: string): string {
  const id = model.toLowerCase().replace(/\[.*\]$/, '')
  return ALIASES[id] ?? id
}

/** The price of a model id (`claude-opus-5-5[1m]`, `anthropic.claude-opus-5-5`, `opus`), or undefined. */
export function priceOf(model: string): Price | undefined {
  const full = cacheKey(model)
  return PRICES.find(([key]) => full.includes(key))?.[1]
}

/** What one request cost, from its usage, or undefined for a model with no known price. */
export function usd(model: string, u: ModelUsage, cache: Cache = CACHE['1h']): number | undefined {
  const p = priceOf(model)
  if (p === undefined) {
    return undefined
  }
  return (u.input_tokens * p.input + u.cache_creation_input_tokens * p.input * cache.write + u.cache_read_input_tokens * p.read + u.output_tokens * p.output) / 1e6
}

/** A turn's expected shape: requests made, tokens written. */
export type Profile = { steps: number; output: number }

// Priors per task tier, replaced by what this person's turns actually look like (see `learn`).
export const PROFILE: Record<Tier, Profile> = {
  haiku: { steps: 2, output: 800 },
  sonnet: { steps: 6, output: 3_000 },
  opus: { steps: 14, output: 9_000 },
  fable: { steps: 20, output: 15_000 },
}

/** Folds one finished turn into a tier's profile (exponential moving average). */
export function learn(profile: Profile, steps: number, output: number): Profile {
  const a = 0.2
  return { steps: profile.steps * (1 - a) + steps * a, output: profile.output * (1 - a) + output * a }
}

/**
 * What a turn of this shape would cost on `model`, given what its prompt cache holds now.
 *
 * The first request writes whatever part of the context the model has not cached (or whose entry lapsed);
 * every request after reads the context from cache; the answer is paid at the output price.
 */
export function turnCost(model: string, context: number, warm: Warm, now: number, profile: Profile, cache: Cache = CACHE['1h']): number | undefined {
  const p = priceOf(model)
  if (p === undefined) {
    return undefined
  }
  const entry = warm[cacheKey(model)]
  const cached = entry !== undefined && now - entry.at < cache.ttlMs ? Math.min(entry.tokens, context) : 0
  const cold = context - cached
  const first = cold * p.input * cache.write + cached * p.read
  const rest = Math.max(0, profile.steps - 1) * context * p.read
  return (first + rest + profile.output * p.output) / 1e6
}

/** Turn cost on `to` minus turn cost on `from`: negative means switching saves money. Undefined when a price is unknown. */
export function switchDelta(from: string, to: string, context: number, warm: Warm, now: number, profile: Profile, cache: Cache = CACHE['1h']): number | undefined {
  const a = turnCost(from, context, warm, now, profile, cache)
  const b = turnCost(to, context, warm, now, profile, cache)
  return a === undefined || b === undefined ? undefined : b - a
}

export function emptyLedger(): Ledger {
  return {
    turns: { haiku: 0, sonnet: 0, opus: 0, fable: 0 },
    routedSteps: 0,
    actualUsd: 0,
    baselineUsd: 0,
    switches: 0,
    holds: 0,
    judgeCalls: 0,
    judgeUsd: 0,
    compressions: 0,
    rawChars: 0,
    keptChars: 0,
  }
}

export type LedgerDelta = Partial<Omit<Ledger, 'turns'>> & { turns?: Partial<Record<Tier, number>> }

/** Adds `delta` to `ledger`, field by field. */
export function addLedger(ledger: Ledger, delta: LedgerDelta): Ledger {
  const next = { ...ledger, turns: { ...ledger.turns } }
  for (const [key, value] of Object.entries(delta) as [keyof Ledger, unknown][]) {
    if (key === 'turns') {
      for (const [tier, n] of Object.entries(value as Partial<Record<Tier, number>>) as [Tier, number][]) {
        next.turns[tier] += n
      }
    } else {
      ;(next[key] as number) += value as number
    }
  }
  return next
}

/** Money saved: routed steps' baseline minus their cost, minus what judging cost. */
export function saved(ledger: Ledger): number {
  return ledger.baselineUsd - ledger.actualUsd - ledger.judgeUsd
}

export function dollars(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}$${abs >= 10 ? abs.toFixed(0) : abs >= 1 ? abs.toFixed(2) : abs >= 0.01 || abs === 0 ? abs.toFixed(3) : abs.toFixed(4)}`
}

/** A count for people: 940, 9.6k, 182k. */
export function size(n: number): string {
  return n < 1_000 ? String(Math.round(n)) : n < 10_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n / 1_000)}k`
}
