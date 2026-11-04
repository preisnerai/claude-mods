import type { Ledger, SessionRecord, Tier } from '../types'
import { addLedger, dollars, emptyLedger, saved, size, workerSaved } from './cost'
import type { LedgerDelta } from './cost'

// The savings history: one record per session, kept in `history.jsonl` beside the decision log. Everything here
// is pure (records in, records or text out); register.tsx reads and writes the file and draws the pane.

/** A calendar period: Monday to Sunday, or the 1st to the month's last day, in local time. */
export type Period = 'week' | 'month'

/** A period's bounds in epoch milliseconds: `start` included, `end` not. */
export type Span = { start: number; end: number }

/** Records past this many (oldest first) are dropped, so the file stays far below the 4 MiB a read takes. */
export const MAX_RECORDS = 3000

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const COUNTERS = (Object.keys(emptyLedger()) as (keyof Ledger)[]).filter((k): k is Exclude<keyof Ledger, 'turns'> => k !== 'turns')
const EPSILON = 1e-12

// ---- ledger deltas -------------------------------------------------------------------------------------------

/** A ledger with every field present: one stored by an older version gains the newer fields at 0. */
export function fullLedger(l: Partial<Ledger> | undefined): Ledger {
  const empty = emptyLedger()
  return { ...empty, ...l, turns: { ...empty.turns, ...l?.turns } }
}

/**
 * What was billed between two readings of the session's ledger. Every counter only grows, so a smaller one
 * means the ledger started over (a new process): then all of `now` is new.
 */
export function ledgerSince(now: Ledger, before: Ledger | null): LedgerDelta {
  const was = before === null || COUNTERS.some(k => (now[k] ?? 0) < (before[k] ?? 0) - EPSILON) ? emptyLedger() : before
  const delta: LedgerDelta = {}
  for (const k of COUNTERS) {
    const d = (now[k] ?? 0) - (was[k] ?? 0)
    if (Math.abs(d) > EPSILON) {
      delta[k] = d
    }
  }
  const turns: Partial<Record<Tier, number>> = {}
  for (const [t, n] of Object.entries(now.turns) as [Tier, number][]) {
    const d = n - (was.turns[t] ?? 0)
    if (d > 0) {
      turns[t] = d
    }
  }
  return Object.keys(turns).length > 0 ? { ...delta, turns } : delta
}

export function isEmptyDelta(d: LedgerDelta): boolean {
  return Object.keys(d).length === 0
}

// ---- records ---------------------------------------------------------------------------------------------------

/** What a new record is labelled with. */
export type RecordInfo = { project: string; model: string; mode: string; prices: string }

/** Adds a session's new billing to its record (made on its first write), oldest session first. */
export function upsert(records: SessionRecord[], id: string, delta: LedgerDelta, now: number, info: RecordInfo): SessionRecord[] {
  const existing = records.find(r => r.id === id)
  const record: SessionRecord = existing === undefined
    ? { v: 1, id, start: now, end: now, ...info, ledger: addLedger(emptyLedger(), delta) }
    : { ...existing, end: Math.max(existing.end, now), ledger: addLedger(fullLedger(existing.ledger), delta) }
  const rest = records.filter(r => r.id !== id)
  return [...rest, record].sort((a, b) => a.start - b.start).slice(-MAX_RECORDS)
}

function isRecord(x: unknown): x is SessionRecord {
  const r = x as Partial<SessionRecord> | null
  return typeof r === 'object' && r !== null && typeof r.id === 'string' && r.id !== '' && Number.isFinite(r.start) && typeof r.ledger === 'object' && r.ledger !== null
}

/**
 * Reads `history.jsonl`: one record per line, a later line for the same session replacing an earlier one.
 * A line that is not a record (a torn write, a hand edit) is skipped, never fatal; so is a missing field.
 */
export function parseHistory(text: string): SessionRecord[] {
  return readHistoryText(text).records
}

/** `parseHistory`, and how many non-empty lines it could not read: the caller keeps a copy before rewriting. */
export function readHistoryText(text: string): { records: SessionRecord[]; skipped: number } {
  const trimmed = text.trim()
  let rows: unknown[] = []
  let skipped = 0
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      rows = Array.isArray(parsed) ? parsed : []
    } catch {
      skipped += 1
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.trim() === '') {
        continue
      }
      try {
        rows.push(JSON.parse(line))
      } catch {
        skipped += 1
      }
    }
  }
  const byId = new Map<string, SessionRecord>()
  for (const row of rows) {
    if (!isRecord(row)) {
      skipped += 1
    } else {
      byId.delete(row.id)
      byId.set(row.id, {
        v: 1,
        id: row.id,
        start: row.start,
        end: Number.isFinite(row.end) ? row.end : row.start,
        project: typeof row.project === 'string' ? row.project : '',
        model: typeof row.model === 'string' ? row.model : '',
        mode: typeof row.mode === 'string' ? row.mode : '',
        prices: typeof row.prices === 'string' ? row.prices : '',
        ledger: fullLedger(row.ledger),
      })
    }
  }
  return { records: [...byId.values()].sort((a, b) => a.start - b.start).slice(-MAX_RECORDS), skipped }
}

export function serializeHistory(records: SessionRecord[]): string {
  return records.length === 0 ? '' : `${records.map(r => JSON.stringify(r)).join('\n')}\n`
}

/** A folder's last name, for a record's `project`: never the path, which would carry the user's name. */
export function folderName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

// ---- periods ---------------------------------------------------------------------------------------------------

/** The week or month `offset` periods from the one holding `now` (-1: the one before). */
export function periodSpan(kind: Period, now: number, offset = 0): Span {
  const d = new Date(now)
  if (kind === 'week') {
    const sinceMonday = (d.getDay() + 6) % 7
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday + offset * 7)
    return { start: start.getTime(), end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).getTime() }
  }
  return { start: new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + offset + 1, 1).getTime() }
}

/** How many periods back from `now`'s the one holding `t` is: 0 for the same one, -1 for the one before. */
export function offsetOf(kind: Period, now: number, t: number): number {
  if (kind === 'week') {
    // Daylight saving makes a week 167 or 169 hours: round to whole weeks.
    return Math.round((periodSpan('week', t).start - periodSpan('week', now).start) / (7 * 86_400_000))
  }
  const a = new Date(t)
  const b = new Date(now)
  return (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth())
}

/** Moves the period by `step`, never past the current one nor before the oldest record's. */
export function shiftOffset(records: SessionRecord[], kind: Period, now: number, offset: number, step: number): number {
  const oldest = records.reduce((min, r) => Math.min(min, r.start), Infinity)
  const floor = oldest === Infinity ? 0 : Math.min(0, offsetOf(kind, now, oldest))
  return Math.max(floor, Math.min(0, offset + step))
}

function day(t: number): string {
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** `this week · Oct 26 – Nov 1`, `Oct 12 – Oct 18`, `last month · Sep 2026`. */
export function periodLabel(kind: Period, span: Span, offset: number): string {
  const range = kind === 'week' ? `${day(span.start)} – ${day(span.end - 86_400_000 / 2)}` : `${MONTHS[new Date(span.start).getMonth()]} ${new Date(span.start).getFullYear()}`
  const relative = offset === 0 ? `this ${kind}` : offset === -1 ? `last ${kind}` : ''
  return relative === '' ? range : `${relative} · ${range}`
}

// ---- aggregation -----------------------------------------------------------------------------------------------

/**
 * Where a saving came from, as the ledger keeps it apart: dollars from routing the main loop, from crew workers,
 * minus the judge's calls (they add up to `saved`), and tokens kept out by Bash compression and by compaction.
 */
export type Parts = { routing: number; workers: number; judge: number; compression: number; compaction: number }

export function partsOf(l: Ledger): Parts {
  const workers = workerSaved(l)
  const routing = l.baselineUsd - l.actualUsd - workers
  const compression = Math.min(l.tokensSaved, Math.max(0, Math.round((l.rawChars - l.keptChars) / 4)))
  return { routing, workers, judge: -l.judgeUsd, compression, compaction: Math.max(0, l.tokensSaved - compression) }
}

/** A session's net saving in dollars: negative when routing cost more than its own model would have. */
export function recordUsd(r: SessionRecord): number {
  return saved(r.ledger)
}

export function recordTokens(r: SessionRecord): number {
  return r.ledger.tokensSaved ?? 0
}

/** The sessions that began inside the span. A session is counted once, in the period it started. */
export function inSpan(records: SessionRecord[], span: Span): SessionRecord[] {
  return records.filter(r => r.start >= span.start && r.start < span.end)
}

export type Totals = {
  sessions: number
  /** Sessions that cost more than their own model would have. */
  costlier: number
  usd: number
  tokens: number
  actualUsd: number
  baselineUsd: number
  parts: Parts
}

/** Every session counted, the ones that cost more included. */
export function totals(records: SessionRecord[]): Totals {
  const sum: Totals = { sessions: 0, costlier: 0, usd: 0, tokens: 0, actualUsd: 0, baselineUsd: 0, parts: { routing: 0, workers: 0, judge: 0, compression: 0, compaction: 0 } }
  for (const r of records) {
    const usd = recordUsd(r)
    const p = partsOf(r.ledger)
    sum.sessions += 1
    sum.costlier += usd < -EPSILON ? 1 : 0
    sum.usd += usd
    sum.tokens += recordTokens(r)
    sum.actualUsd += r.ledger.actualUsd + r.ledger.judgeUsd
    sum.baselineUsd += r.ledger.baselineUsd
    sum.parts = {
      routing: sum.parts.routing + p.routing,
      workers: sum.parts.workers + p.workers,
      judge: sum.parts.judge + p.judge,
      compression: sum.parts.compression + p.compression,
      compaction: sum.parts.compaction + p.compaction,
    }
  }
  return sum
}

export type Day = { start: number; usd: number; tokens: number; sessions: number }

/** Every day of the span, each with the sessions that began on it. */
export function daysOf(records: SessionRecord[], span: Span): Day[] {
  const days: Day[] = []
  const first = new Date(span.start)
  for (let i = 0; ; i++) {
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime()
    if (start >= span.end) {
      break
    }
    const end = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i + 1).getTime()
    const t = totals(inSpan(records, { start, end }))
    days.push({ start, usd: t.usd, tokens: t.tokens, sessions: t.sessions })
  }
  return days
}

/** Best first, worst last: by dollars, then tokens. */
export function ranked(records: SessionRecord[]): SessionRecord[] {
  return [...records].sort((a, b) => recordUsd(b) - recordUsd(a) || recordTokens(b) - recordTokens(a) || a.start - b.start)
}

/** A long ranked list cut in the middle: the best and the worst stay, so a loss is never hidden. */
export function trim<T>(list: T[], cap: number): { best: T[]; worst: T[]; hidden: number } {
  if (list.length <= cap) {
    return { best: list, worst: [], hidden: 0 }
  }
  const half = Math.ceil(cap / 2)
  return { best: list.slice(0, half), worst: list.slice(list.length - (cap - half)), hidden: list.length - cap }
}

export type Summary = {
  kind: Period
  offset: number
  span: Span
  label: string
  current: Totals
  previous: Totals
  previousLabel: string
  days: Day[]
  /** The period's sessions, best first. */
  sessions: SessionRecord[]
}

/** One period of the history beside the period before it. */
export function summarizePeriod(records: SessionRecord[], kind: Period, now: number, offset: number): Summary {
  const span = periodSpan(kind, now, offset)
  const before = periodSpan(kind, now, offset - 1)
  const mine = inSpan(records, span)
  return {
    kind,
    offset,
    span,
    label: periodLabel(kind, span, offset),
    current: totals(mine),
    previous: totals(inSpan(records, before)),
    previousLabel: periodLabel(kind, before, offset - 1),
    days: daysOf(records, span),
    sessions: ranked(mine),
  }
}

// ---- words -----------------------------------------------------------------------------------------------------

/** `+$0.420`, `-$0.100`: a net saving, where a loss shows as a loss. */
export function signedUsd(n: number): string {
  return Math.abs(n) < EPSILON ? dollars(0) : n > 0 ? `+${dollars(n)}` : dollars(n)
}

export function signedTokens(n: number): string {
  return n === 0 ? '0' : n > 0 ? `+${size(n)}` : `-${size(-n)}`
}

/** A bar of up to `width` cells for |value| against the largest |value|: █ for a saving, ░ for a loss. */
export function bar(value: number, max: number, width: number): string {
  if (max <= 0 || Math.abs(value) < EPSILON) {
    return ''
  }
  return (value > 0 ? '█' : '░').repeat(Math.max(1, Math.round((Math.abs(value) / max) * width)))
}

/** `Mo 27`. */
export function dayLabel(t: number): string {
  const d = new Date(t)
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, ' ')}`
}

/** `Oct 28 14:02`. */
export function stamp(t: number): string {
  const d = new Date(t)
  return `${day(t)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `Opus` for any Opus id; an unknown model as it is named. */
export function modelName(model: string): string {
  const tier = /haiku|sonnet|opus|fable/.exec(model.toLowerCase())?.[0]
  return tier === undefined ? model || '?' : `${tier[0]!.toUpperCase()}${tier.slice(1)}`
}

/** The net of a period or session: `net +$1.24 · ≈182k tok`. */
export function netLine(usd: number, tokens: number): string {
  return `net ${signedUsd(usd)} · ≈${size(tokens)} tok`
}

/** `routing +$1.50 · crew +$0.200 · judge -$0.010`, the dollar sources that add up to the net. */
export function usdParts(p: Parts): string {
  return [`routing ${signedUsd(p.routing)}`, `crew ${signedUsd(p.workers)}`, `judge ${signedUsd(p.judge)}`].join(' · ')
}

/** `compression ≈120k · compaction ≈62k tok`, the token sources. */
export function tokenParts(p: Parts): string {
  return `compression ≈${size(p.compression)} · compaction ≈${size(p.compaction)} tok`
}

/** One session in a list: `+$0.420 · ≈40k tok · Oct 28 14:02 · my-app`. */
export function sessionLine(r: SessionRecord): string {
  return [signedUsd(recordUsd(r)), `≈${size(recordTokens(r))} tok`, stamp(r.start), r.project].filter(Boolean).join(' · ')
}

/** What a session's numbers are made of, to check one against the ledger it came from. */
export function sessionDetail(r: SessionRecord): string[] {
  const l = r.ledger
  const p = partsOf(l)
  const turns = (Object.entries(l.turns) as [Tier, number][]).filter(([, n]) => n > 0).map(([t, n]) => `${modelName(t)} ${n}`).join(' · ') || 'none'
  const requests = l.cacheHits + l.cacheMisses
  return [
    `${stamp(r.start)} → ${stamp(r.end)} · vs your ${modelName(r.model)} · ${r.mode || '?'} · prices ${r.prices || '?'}`,
    `spent ${dollars(l.actualUsd + l.judgeUsd)} instead of ${dollars(l.baselineUsd)} · ${l.routedSteps} requests on another model`,
    usdParts(p),
    tokenParts(p),
    `turns ${turns} · cache ${requests === 0 ? '—' : `${Math.round((l.cacheHits / requests) * 100)}%`} · session ${r.id.slice(0, 8)}`,
  ]
}

/** The comparison with the period before: `vs last week: +$0.300 · +40k tok`. */
export function compareLine(s: Summary): string {
  const name = s.previousLabel.split(' · ')[0]
  if (s.previous.sessions === 0) {
    return `vs ${name}: no sessions then`
  }
  return `vs ${name}: ${signedUsd(s.current.usd - s.previous.usd)} · ${signedTokens(s.current.tokens - s.previous.tokens)} tok (was ${signedUsd(s.previous.usd)})`
}

/** The totals line: `9 sessions · 2 cost more · spent $4.10 instead of $5.34`. */
export function countLine(t: Totals): string {
  if (t.sessions === 0) {
    return 'no sessions'
  }
  return `${t.sessions} session${t.sessions === 1 ? '' : 's'}${t.costlier > 0 ? ` · ${t.costlier} cost more` : ''} · spent ${dollars(t.actualUsd)} instead of ${dollars(t.baselineUsd)}`
}

/** `/router stats`: the same summary as the pane, as text for surfaces with no pane. */
export function statsText(records: SessionRecord[], kind: Period, now: number, offset: number, where: string): string {
  const s = summarizePeriod(records, kind, now, offset)
  const lines = [`model-router savings — ${s.label}`, '']
  if (s.current.sessions === 0) {
    lines.push('No sessions recorded in this period.', compareLine(s))
  } else {
    lines.push(
      `**${netLine(s.current.usd, s.current.tokens)}** · ${countLine(s.current)}`,
      compareLine(s),
      `by source: ${usdParts(s.current.parts)} · ${tokenParts(s.current.parts)}`,
      '',
      '| day | net | tokens | sessions |',
      '|---|---|---|---|',
      ...s.days.filter(d => kind === 'week' || d.sessions > 0).map(d => `| ${dayLabel(d.start)} | ${d.sessions === 0 ? '—' : signedUsd(d.usd)} | ${d.sessions === 0 ? '—' : `≈${size(d.tokens)}`} | ${d.sessions} |`),
      '',
      '| session (best first) | net | tokens | spent / on your model | sources |',
      '|---|---|---|---|---|',
    )
    const { best, worst, hidden } = trim(s.sessions, 20)
    const row = (r: SessionRecord) =>
      `| ${stamp(r.start)}${r.project === '' ? '' : ` · ${r.project}`} · vs ${modelName(r.model)} | ${signedUsd(recordUsd(r))} | ≈${size(recordTokens(r))} | ${dollars(r.ledger.actualUsd + r.ledger.judgeUsd)} / ${dollars(r.ledger.baselineUsd)} | ${usdParts(partsOf(r.ledger))} |`
    lines.push(...best.map(row), ...(hidden > 0 ? [`| … ${hidden} more | | | | |`] : []), ...worst.map(row))
  }
  lines.push(
    '',
    `Dollars are list-price estimates against each session's own /model, priced when they ran; tokens are tool output and transcript kept out of the context. Weeks run Monday to Sunday; a session counts in the period it started. History: \`${where}\`. \`/router stats week|month [n]\` shows n periods back.`,
  )
  return lines.join('\n')
}
