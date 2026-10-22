import type { Effort, Tier } from '../types'
import { ORDER, rank } from './classify'
import type { Verdict } from './classify'

// The efforts the router may send. Never `max` or `ultracode`: the router tops out at xhigh (Extra in Desktop);
// Ultracode is a workflow switch, added as a keyword, not an effort level sent per request.
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh']

/** Any effort brought within what the router sends: `max`, `ultracode` (or anything past xhigh) becomes xhigh. */
export function clampEffort(value: unknown, fallback: Effort): Effort {
  if (value === 'max' || value === 'ultracode') {
    return 'xhigh'
  }
  return (EFFORTS as readonly unknown[]).includes(value) ? (value as Effort) : fallback
}

/** The Desktop names for effort, so a status line reads like the picker. */
export function effortLabel(value: unknown): string {
  const key = String(value ?? '').toLowerCase()
  if (key === '') {
    return 'auto'
  }
  if (key === 'xhigh') {
    return 'Extra'
  }
  if (key === 'max') {
    return 'Max'
  }
  if (key === 'ultracode') {
    return 'Ultracode'
  }
  return key
}

function stepEffort(e: Effort, by: number): Effort {
  return EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(e) + by))] ?? e
}

// Rule labels that say a task is harder, or easier, than most of its tier.
const DEEP = new Set([
  'unexplained failure',
  'diagnosis',
  'hard bug',
  'architecture',
  'security',
  'investigation',
  'migration plan',
  'proof',
  'formal research',
  'research',
  'production incident',
  'deep review',
  'business diagnosis',
  'legal review',
  'contract drafting',
  'automation design',
  'data analysis',
])
const LIGHT = new Set([
  'translation',
  'typo',
  'rename',
  'version bump',
  'formatting',
  'format conversion',
  'commit message',
  'quick question',
  'summary',
  'short prose',
  'simple research',
  'text polish',
  'email',
  'simple sheet',
  'simple formula',
  'simple sheet edit',
  'simple browser',
  'read a file',
])

/** What a verdict is learned under: its strongest rule's label, or how it was judged. */
export function categoryOf(v: Verdict): string {
  return v.source === 'rule' ? (v.why.split(', ')[0] ?? 'rule') : v.source
}

function labels(v: Verdict): string[] {
  return v.source === 'rule' ? v.why.split(', ') : []
}

/**
 * The effort a task gets within its tier: one step up for a confident deep task (diagnosis, architecture,
 * security), one down for a trivial one (translate, rename), plus what this person's corrections taught.
 */
export function effortFor(v: Verdict, base: Effort, learned = 0): Effort {
  const l = labels(v)
  let by = learned
  if (l.includes('simple research')) {
    by -= 1
  } else if (l.some(x => DEEP.has(x)) && v.confidence >= 0.8) {
    by += 1
  } else if (l.length > 0 && l.every(x => LIGHT.has(x))) {
    by -= 1
  }
  return stepEffort(clampEffort(base, 'medium'), by)
}

// The hardest work: where a multi-agent run often finishes sooner, and so cheaper, despite dearer turns.
const HARDEST = new Set([
  'unexplained failure',
  'hard bug',
  'architecture',
  'security',
  'migration plan',
  'wide change',
  'investigation',
  'proof',
  'formal research',
  'production incident',
  'deep review',
])

export function isHardest(v: Verdict): boolean {
  return rank(v.tier) >= rank('opus') && v.source === 'rule' && v.confidence >= 0.85 && labels(v).some(x => HARDEST.has(x))
}

export const ULTRACODE = /(?<![\p{L}\p{N}_])ultracode(?![\p{L}\p{N}_])/iu

/** Learned shifts per category: tiers and effort steps, each -2..+2, fading with a half-life. */
export type Bias = Record<string, { tier: number; effort: number; at: number }>

const HALF_LIFE_MS = 14 * 24 * 60 * 60_000
const LIMIT = 2
const CATEGORIES = 64

function faded(value: number, at: number, now: number): number {
  return value * 0.5 ** (Math.max(0, now - at) / HALF_LIFE_MS)
}

/** One correction folded into the bias: older ones fade first, the sum stays within -2..+2. */
export function nudge(bias: Bias, category: string, field: 'tier' | 'effort', delta: number, now: number): Bias {
  const old = bias[category]
  const clamp = (n: number) => Math.max(-LIMIT, Math.min(LIMIT, n))
  const next = {
    tier: clamp(old === undefined ? 0 : faded(old.tier, old.at, now)),
    effort: clamp(old === undefined ? 0 : faded(old.effort, old.at, now)),
    at: now,
  }
  next[field] = clamp(next[field] + Math.sign(delta))
  const all = { ...bias, [category]: next }
  // Bounded: the least recently corrected categories go first.
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, CATEGORIES)
  return Object.fromEntries(kept)
}

/** The whole steps a category shifts by now. */
export function shiftOf(bias: Bias | undefined, category: string, now: number): { tier: number; effort: number } {
  const b = bias?.[category]
  if (b === undefined) {
    return { tier: 0, effort: 0 }
  }
  return { tier: Math.round(faded(b.tier, b.at, now)), effort: Math.round(faded(b.effort, b.at, now)) }
}

/** A tier moved by a learned shift, never past the strongest tier on offer. */
export function shiftTier(tier: Tier, by: number, enableFable: boolean): Tier {
  const top = rank(enableFable ? 'fable' : 'opus')
  return ORDER[Math.max(0, Math.min(top, rank(tier) + by))] ?? tier
}

/** "diagnosis +1 effort, translation -1 tier", or undefined when nothing is learned. */
export function learnedLine(bias: Bias | undefined, now: number): string | undefined {
  const parts: string[] = []
  for (const category of Object.keys(bias ?? {})) {
    const s = shiftOf(bias, category, now)
    const sign = (n: number) => (n > 0 ? `+${n}` : String(n))
    if (s.tier !== 0) parts.push(`${category} ${sign(s.tier)} tier`)
    if (s.effort !== 0) parts.push(`${category} ${sign(s.effort)} effort`)
  }
  return parts.length === 0 ? undefined : parts.join(', ')
}
