import type { ModelUsage } from 'claude-code'

import type { Ledger, Tier, Warm } from '../types'

/** List prices in USD per million tokens: uncached input, output, cache read. */
export type Card = { input: number; output: number; read: number }

/** A model's prices: one card, and for some models a dearer one past a prompt size. */
export type Price = Card & { long?: Card & { above: number } }

// Anthropic first-party list prices (October 2026). Longest id first, so `claude-opus-5-5` wins over `claude-opus-5`.
// Haiku 5.5 bills a prompt over 100K tokens at $0.50 / $2.50 (cache reads at the usual tenth of input).
const PRICES: [string, Price][] = (
  [
    ['claude-haiku-5-5', { input: 0.1, output: 0.5, read: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, read: 0.05 } }],
    ['claude-sonnet-5-5', { input: 2, output: 10, read: 0.1 }],
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

/** One model's id, whatever variant a request named (`claude-opus-5-5[1m]`, `anthropic.claude-opus-5-5`, `opus`). */
export function canonical(model: string): string {
  const id = model.toLowerCase().replace(/\[.*\]$/, '')
  return ALIASES[id] ?? id
}

/**
 * The prompt cache a request reads: one per model and effort. Caches belong to a model, and changing the
 * request's top-level effort rebuilds the cached messages too.
 */
export function cacheKey(model: string, effort?: string | number): string {
  return `${canonical(model)}@${effort ?? ''}`
}

/** The price of a model id, or undefined. */
export function priceOf(model: string): Price | undefined {
  const full = canonical(model)
  return PRICES.find(([key]) => full.includes(key))?.[1]
}

/** The card a prompt of this many tokens is billed by. */
export function cardFor(p: Price, promptTokens: number): Card {
  return p.long !== undefined && promptTokens > p.long.above ? p.long : p
}

/** Input tokens a request carried: uncached, written and read together. */
export function promptOf(u: ModelUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/** What one request cost, from its usage, or undefined for a model with no known price. */
export function usd(model: string, u: ModelUsage, cache: Cache = CACHE['1h']): number | undefined {
  const p = priceOf(model)
  if (p === undefined) {
    return undefined
  }
  const c = cardFor(p, promptOf(u))
  return (u.input_tokens * c.input + u.cache_creation_input_tokens * c.input * cache.write + u.cache_read_input_tokens * c.read + u.output_tokens * c.output) / 1e6
}

/** How many tokens of a prompt this cache entry still holds at `now`. */
export function cachedOf(entry: { tokens: number; at: number } | undefined, prompt: number, now: number, cache: Cache): number {
  return entry !== undefined && now - entry.at < cache.ttlMs ? Math.min(entry.tokens, prompt) : 0
}

/**
 * What a request of `prompt` tokens costs on `model` when its cache holds `cached` of them: the rest is written
 * (Claude Code marks the cache at the end of every request), the cached part read, the answer paid as output.
 */
export function requestCost(model: string, prompt: number, cached: number, output: number, cache: Cache): number | undefined {
  const p = priceOf(model)
  if (p === undefined) {
    return undefined
  }
  const c = cardFor(p, prompt)
  return ((prompt - cached) * c.input * cache.write + cached * c.read + output * c.output) / 1e6
}

/** A turn's expected shape: requests made, tokens written, tokens the context grows by per request. */
export type Profile = { steps: number; output: number; added: number }

// Priors per task tier, replaced by what this person's turns actually look like (see `learn`).
export const PROFILE: Record<Tier, Profile> = {
  haiku: { steps: 2, output: 800, added: 3_000 },
  sonnet: { steps: 6, output: 3_000, added: 6_000 },
  opus: { steps: 14, output: 9_000, added: 8_000 },
  fable: { steps: 20, output: 15_000, added: 8_000 },
}

/** Folds one finished turn into a tier's profile (exponential moving average). */
export function learn(profile: Partial<Profile>, prior: Profile, steps: number, output: number, added?: number): Profile {
  const a = 0.2
  const mix = (old: number | undefined, fallback: number, now: number) => (old ?? fallback) * (1 - a) + now * a
  return { steps: mix(profile.steps, prior.steps, steps), output: mix(profile.output, prior.output, output), added: added === undefined ? (profile.added ?? prior.added) : mix(profile.added, prior.added, added) }
}

/**
 * What a turn of this shape would cost on `model` at `effort`, given what its prompt cache holds now.
 *
 * Request 1 writes whatever part of the context that cache lacks. Each later request reads the one before it
 * from cache and writes what was added since (the last answer and the tool results). Each request is priced
 * by its own size, so a model with a long-context rate pays it once the conversation passes the threshold.
 */
export function turnCost(model: string, effort: string | number | undefined, context: number, warm: Warm, now: number, profile: Profile, cache: Cache = CACHE['1h']): number | undefined {
  const steps = Math.max(1, Math.round(profile.steps))
  const outputPerStep = profile.output / steps
  let total = 0
  for (let i = 0; i < steps; i++) {
    const prompt = context + i * profile.added
    const cached = i === 0 ? cachedOf(warm[cacheKey(model, effort)], prompt, now, cache) : prompt - profile.added
    const cost = requestCost(model, prompt, cached, outputPerStep, cache)
    if (cost === undefined) {
      return undefined
    }
    total += cost
  }
  return total
}

/** A route: the model and effort a request is sent with. */
export type Target = { model: string; effort?: string | number }

/** Turn cost on `to` minus turn cost on `from`: negative means switching saves money. Undefined when a price is unknown. */
export function switchDelta(from: Target, to: Target, context: number, warm: Warm, now: number, profile: Profile, cache: Cache = CACHE['1h']): number | undefined {
  const a = turnCost(from.model, from.effort, context, warm, now, profile, cache)
  const b = turnCost(to.model, to.effort, context, warm, now, profile, cache)
  return a === undefined || b === undefined ? undefined : b - a
}

export function emptyLedger(): Ledger {
  return {
    turns: { haiku: 0, sonnet: 0, opus: 0, fable: 0 },
    routedSteps: 0,
    actualUsd: 0,
    baselineUsd: 0,
    workerSteps: 0,
    workerRoutedSteps: 0,
    workerActualUsd: 0,
    workerBaselineUsd: 0,
    switches: 0,
    holds: 0,
    judgeCalls: 0,
    judgeUsd: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    compressions: 0,
    rawChars: 0,
    keptChars: 0,
    tokensSaved: 0,
  }
}

export type LedgerDelta = Partial<Omit<Ledger, 'turns'>> & { turns?: Partial<Record<Tier, number>> }

/** Adds `delta` to `ledger`, field by field. */
export function addLedger(ledger: Ledger, delta: LedgerDelta): Ledger {
  const next = { ...ledger, turns: { ...ledger.turns } }
  for (const [key, value] of Object.entries(delta) as [keyof Ledger, unknown][]) {
    if (key === 'turns') {
      for (const [tier, n] of Object.entries(value as Partial<Record<Tier, number>>) as [Tier, number][]) {
        next.turns[tier] = (next.turns[tier] ?? 0) + n
      }
    } else {
      // A ledger stored by an older version lacks the newer fields: they start from 0, never NaN.
      ;(next[key] as number) = ((next[key] as number | undefined) ?? 0) + (value as number)
    }
  }
  return next
}

/** Money saved: what the session's own model would have charged, minus what was charged, minus judging. Negative: it cost more. */
export function saved(ledger: Ledger): number {
  return ledger.baselineUsd - ledger.actualUsd - ledger.judgeUsd
}

/** The crew workers' part of `saved`: their requests against the same requests on the session's own model. */
export function workerSaved(ledger: Ledger): number {
  return (ledger.workerBaselineUsd ?? 0) - (ledger.workerActualUsd ?? 0)
}

/** The main loop's part of `saved`, judging included. */
export function mainSaved(ledger: Ledger): number {
  return saved(ledger) - workerSaved(ledger)
}

/**
 * A saving for people: `saved ≈$0.12`, or, when routing cost more than the session's own model would have,
 * `extra ≈$0.40 vs your Haiku`, never a `saved -$0.40`.
 */
export function savingsText(n: number, baseline: string): string {
  return n >= 0 ? `saved ≈${dollars(n)}` : `extra ≈${dollars(-n)} vs your ${baseline}`
}

/** Share of requests that read any cache; undefined before the first cacheable request. */
export function cacheHitRate(ledger: Ledger): number | undefined {
  const requests = ledger.cacheHits + ledger.cacheMisses
  return requests === 0 ? undefined : ledger.cacheHits / requests
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
