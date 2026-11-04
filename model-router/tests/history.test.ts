import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionRecord } from '../types'
import { addLedger, emptyLedger, saved } from '../hooks/cost'
import {
  bar,
  compareLine,
  dayRow,
  daysOf,
  fit,
  folderName,
  inSpan,
  isEmptyDelta,
  ledgerSince,
  offsetOf,
  paneWidth,
  parseHistory,
  partsOf,
  periodLabel,
  periodSpan,
  ranked,
  readHistoryText,
  serializeHistory,
  sessionRow,
  shiftOffset,
  shortRange,
  signedUsd,
  sourcesLine,
  statsText,
  subLine,
  summarizePeriod,
  totals,
  trim,
  upsert,
} from '../hooks/history'

function near(actual: number | undefined, expected: number) {
  expect({ actual, near: Math.abs((actual ?? NaN) - expected) < 1e-9 }).toEqual({ actual, near: true })
}

// Local time throughout, as the periods are: Friday 30 October 2026, 15:00. Its week runs Mon 26 Oct – Sun 1 Nov.
const at = (month: number, date: number, hour = 12, minute = 0, year = 2026) => new Date(year, month - 1, date, hour, minute).getTime()
const NOW = at(10, 30, 15)
const INFO = { project: 'my-app', model: 'claude-opus-5-5', mode: 'route', prices: '2026-10' }

/** A session that began at `start`, with the ledger it billed. */
function rec(id: string, start: number, delta: Parameters<typeof addLedger>[1]): SessionRecord {
  return { v: 1, id, start, end: start + 3_600_000, ...INFO, ledger: addLedger(emptyLedger(), delta) }
}

test('a week runs Monday to Sunday in local time, and the one before it is a week back', () => {
  expect(periodSpan('week', NOW)).toEqual({ start: at(10, 26, 0), end: at(11, 2, 0) })
  expect(periodSpan('week', at(11, 1, 23, 59))).toEqual(periodSpan('week', NOW))
  expect(periodSpan('week', at(11, 2, 0)).start).toBe(at(11, 2, 0))
  expect(periodSpan('week', at(10, 26, 0)).start).toBe(at(10, 26, 0))
  expect(periodSpan('week', NOW, -1)).toEqual({ start: at(10, 19, 0), end: at(10, 26, 0) })
})

test('a month runs from the 1st, and stepping back crosses the year', () => {
  expect(periodSpan('month', NOW)).toEqual({ start: at(10, 1, 0), end: at(11, 1, 0) })
  expect(periodSpan('month', NOW, -10)).toEqual({ start: at(12, 1, 0, 0, 2025), end: at(1, 1, 0) })
  expect(periodSpan('month', at(1, 15), -1).start).toBe(at(12, 1, 0, 0, 2025))
})

test('periods are labelled by their days, with this and last named', () => {
  expect(periodLabel('week', periodSpan('week', NOW), 0)).toBe('this week · Oct 26 – Nov 1')
  expect(periodLabel('week', periodSpan('week', NOW, -1), -1)).toBe('last week · Oct 19 – Oct 25')
  expect(periodLabel('week', periodSpan('week', NOW, -2), -2)).toBe('Oct 12 – Oct 18')
  expect(periodLabel('month', periodSpan('month', NOW), 0)).toBe('this month · Oct 2026')
  expect(periodLabel('month', periodSpan('month', NOW, -2), -2)).toBe('Aug 2026')
})

test('navigation stops at the current period and at the oldest recorded one', () => {
  const records = [rec('old', at(9, 10), { actualUsd: 1, baselineUsd: 2 }), rec('new', at(10, 29), { actualUsd: 1, baselineUsd: 2 })]
  expect(offsetOf('week', NOW, at(9, 10))).toBe(-7)
  expect(offsetOf('month', NOW, at(9, 10))).toBe(-1)
  expect(shiftOffset(records, 'week', NOW, 0, 1)).toBe(0)
  expect(shiftOffset(records, 'week', NOW, 0, -1)).toBe(-1)
  expect(shiftOffset(records, 'week', NOW, -7, -1)).toBe(-7)
  expect(shiftOffset(records, 'month', NOW, -1, -1)).toBe(-1)
  expect(shiftOffset([], 'month', NOW, 0, -1)).toBe(0)
})

test('only what the ledger billed since the last write is new, and a restarted ledger counts whole', () => {
  const first = addLedger(emptyLedger(), { turns: { haiku: 1 }, actualUsd: 0.1, baselineUsd: 0.5, tokensSaved: 100 })
  const later = addLedger(first, { turns: { haiku: 1, opus: 1 }, actualUsd: 0.2, baselineUsd: 0.2 })
  const d = ledgerSince(later, first)
  near(d.actualUsd, 0.2)
  near(d.baselineUsd, 0.2)
  expect(d.turns).toEqual({ haiku: 1, opus: 1 })
  expect(d.tokensSaved).toBeUndefined()
  expect(isEmptyDelta(ledgerSince(later, later))).toBe(true)
  // A ledger smaller than the mark started over: all of it is new.
  near(ledgerSince(first, later).actualUsd, 0.1)
  near(ledgerSince(first, null).baselineUsd, 0.5)
})

test('one record per session: the first write makes it, later writes add to it', () => {
  let records = upsert([], 's1', { actualUsd: 0.1, baselineUsd: 0.4, turns: { sonnet: 1 } }, at(10, 28, 9), INFO)
  records = upsert(records, 's1', { actualUsd: 0.1, baselineUsd: 0.1, turns: { sonnet: 1 } }, at(10, 28, 10), INFO)
  records = upsert(records, 's0', { actualUsd: 1 }, at(10, 27), { ...INFO, project: 'other' })
  expect(records.map(r => r.id)).toEqual(['s0', 's1'])
  const s1 = records[1]!
  expect([s1.start, s1.end]).toEqual([at(10, 28, 9), at(10, 28, 10)])
  expect(s1.ledger.turns.sonnet).toBe(2)
  near(saved(s1.ledger), 0.3)
  expect(s1.prices).toBe('2026-10')
})

test('the history file survives torn lines, hand edits and older records', () => {
  const good = rec('a', at(10, 27), { actualUsd: 0.1, baselineUsd: 0.3 })
  const newer = rec('a', at(10, 27), { actualUsd: 0.2, baselineUsd: 0.9 })
  const { workerSteps: _w, ...oldLedger } = emptyLedger()
  const text = [
    JSON.stringify(good),
    '{"id":"torn","start":17',
    'not json',
    JSON.stringify({ id: 'b', start: at(10, 28), ledger: oldLedger }),
    JSON.stringify({ id: 42 }),
    '',
    JSON.stringify(newer),
  ].join('\r\n')
  const { records, skipped } = readHistoryText(text)
  expect(skipped).toBe(3)
  expect(records.map(r => r.id)).toEqual(['a', 'b'])
  near(saved(records[0]!.ledger), 0.7)
  expect(records[1]!.ledger.workerSteps).toBe(0)
  expect(records[1]!.end).toBe(at(10, 28))
  expect(parseHistory('')).toEqual([])
  expect(parseHistory(JSON.stringify([good])).length).toBe(1)
  expect(parseHistory(serializeHistory(records))).toEqual(records)
})

test('totals count every session, a costlier one included, and the sources add up to the net', () => {
  const records = [
    rec('win', at(10, 27), { actualUsd: 0.5, baselineUsd: 1.5, workerActualUsd: 0.1, workerBaselineUsd: 0.4, judgeUsd: 0.01, rawChars: 40_000, keptChars: 8_000, tokensSaved: 30_000 }),
    rec('loss', at(10, 28), { actualUsd: 0.9, baselineUsd: 0.5 }),
  ]
  const t = totals(records)
  expect([t.sessions, t.costlier]).toEqual([2, 1])
  near(t.usd, 0.99 - 0.4)
  near(t.parts.routing + t.parts.workers + t.parts.judge, t.usd)
  near(t.parts.workers, 0.3)
  near(t.parts.judge, -0.01)
  expect([t.parts.compression, t.parts.compaction, t.tokens]).toEqual([8_000, 22_000, 30_000])
  near(t.baselineUsd - t.actualUsd, t.usd)
  const p = partsOf(records[1]!.ledger)
  near(p.routing, -0.4)
})

test('a week has seven days, a month all of its own, each with the sessions that began on it', () => {
  const records = [rec('mon', at(10, 26, 8), { actualUsd: 0.1, baselineUsd: 0.3 }), rec('sun', at(11, 1, 23), { actualUsd: 0.3, baselineUsd: 0.1 }), rec('next', at(11, 2, 1), { baselineUsd: 5 })]
  const week = daysOf(records, periodSpan('week', NOW))
  expect(week.length).toBe(7)
  expect(week.map(d => d.sessions)).toEqual([1, 0, 0, 0, 0, 0, 1])
  near(week[6]!.usd, -0.2)
  expect(daysOf([], periodSpan('month', NOW)).length).toBe(31)
  expect(inSpan(records, periodSpan('week', NOW)).map(r => r.id)).toEqual(['mon', 'sun'])
})

test('sessions rank best first, and a cut list keeps the worst in view', () => {
  const records = [-0.2, 0.5, 0.1, 0.9, -0.6].map((n, i) => rec(`s${i}`, at(10, 27, i), { baselineUsd: Math.max(0, n), actualUsd: Math.max(0, -n) }))
  expect(ranked(records).map(r => r.id)).toEqual(['s3', 's1', 's2', 's0', 's4'])
  const cut = trim(ranked(records), 3)
  expect([cut.best.map(r => r.id), cut.worst.map(r => r.id), cut.hidden]).toEqual([['s3', 's1'], ['s4'], 2])
  expect(trim(records, 10).hidden).toBe(0)
})

test('a period is compared with the one before it', () => {
  const records = [rec('prev', at(10, 20), { actualUsd: 0.2, baselineUsd: 0.5, tokensSaved: 1_000 }), rec('now', at(10, 29), { actualUsd: 0.2, baselineUsd: 1.2, tokensSaved: 10_000 })]
  const s = summarizePeriod(records, 'week', NOW, 0)
  near(s.current.usd, 1)
  near(s.previous.usd, 0.3)
  expect(compareLine(s)).toBe('vs last week: +$0.700 · +9.0k tok (was +$0.300)')
  expect(compareLine(summarizePeriod(records, 'week', NOW, -1))).toBe('vs Oct 12 – Oct 18: no sessions then')
  expect(summarizePeriod(records, 'week', NOW, -1).sessions.map(r => r.id)).toEqual(['prev'])
})

test('/router stats text shows the net honestly, losses and all', () => {
  const records = [rec('good', at(10, 27, 9), { actualUsd: 0.2, baselineUsd: 1.2, tokensSaved: 10_000 }), rec('bad', at(10, 28, 9), { actualUsd: 0.6, baselineUsd: 0.2 })]
  const text = statsText(records, 'week', NOW, 0, '/home/dev/.claude/model-router/history.jsonl')
  expect(text).toContain('model-router savings — this week · Oct 26 – Nov 1')
  expect(text).toContain('net +$0.600 · ≈10k tok')
  expect(text).toContain('2 sessions · 1 cost more · spent $0.800 instead of $1.40')
  expect(text).toContain('| Mo 26 | — | — | 0 |')
  expect(text.indexOf('Oct 27 09:00')).toBeLessThan(text.indexOf('Oct 28 09:00'))
  expect(text).toContain('| -$0.400 |')
  expect(statsText([], 'month', NOW, -1, 'x')).toContain('No sessions recorded in this period.')
})

test('money, bars and folders read well', () => {
  expect([signedUsd(0.42), signedUsd(-0.1), signedUsd(0)]).toEqual(['+$0.420', '-$0.100', '$0.000'])
  expect([bar(1, 2, 10), bar(-2, 2, 10), bar(0, 2, 10), bar(0.01, 2, 10)]).toEqual(['█████', '░░░░░░░░░░', '', '█'])
  expect([folderName('/home/dev/my-app/'), folderName('C:\\Users\\dev\\work\\api'), folderName('')]).toEqual(['my-app', 'api', ''])
})

test('pane rows fill the pane width exactly and cut only the left part', () => {
  expect(fit('Nov 4 10:00 a-very-long-project-folder-name', '+$0.420', 30)).toBe('Nov 4 10:00 a-very-lo… +$0.420')
  expect(fit('Nov 4 10:00 app', '-$0.100', 30)).toBe('Nov 4 10:00 app        -$0.100')
  for (const width of [24, 30, 38]) {
    const r = rec('s', at(11, 4, 10), { actualUsd: 0.7, baselineUsd: 0.2, tokensSaved: 12_000 })
    const row = sessionRow({ ...r, project: 'a-folder-with-a-long-name' }, width)
    expect((row.left + row.right).length).toBe(width)
    expect(row.right).toBe('≈12k -$0.500')
  }
  expect([paneWidth(undefined), paneWidth(10), paneWidth(36), paneWidth(200)]).toEqual([34, 24, 36, 40])
})

test('a day is a thin bar against the biggest day of the period, its net at the right; an empty day a dot', () => {
  const days = [{ start: at(11, 2, 0), usd: 1, tokens: 0, sessions: 2 }, { start: at(11, 3, 0), usd: -0.25, tokens: 0, sessions: 1 }, { start: at(11, 4, 0), usd: 0, tokens: 0, sessions: 0 }]
  const [big, loss, none] = days.map(d => dayRow(d, 1, 30))
  expect(`${big!.label} ${big!.bar} ${big!.amount}`.length).toBe(30)
  expect(big!.bar.trim()).toBe('━'.repeat(big!.bar.length))
  expect([loss!.isLoss, loss!.bar.trim().length, loss!.amount]).toEqual([true, Math.round(big!.bar.length / 4), '-$0.250'])
  expect([none!.isEmpty, none!.bar, none!.amount]).toEqual([true, '·', ''])
})

test('the pane leaves out every source that is zero, and says the week in a few cells', () => {
  expect(sourcesLine(partsOf(addLedger(emptyLedger(), { actualUsd: 0.6, baselineUsd: 0.1 })))).toBe('routing -$0.500')
  expect(sourcesLine(partsOf(emptyLedger()))).toBe('')
  expect(sourcesLine(partsOf(addLedger(emptyLedger(), { baselineUsd: 1, actualUsd: 0.5, workerBaselineUsd: 0.4, workerActualUsd: 0.1, rawChars: 8_000, keptChars: 0, tokensSaved: 5_000 })))).toBe('routing +$0.200 · crew +$0.300 · ≈2.0k tok compressed · ≈3.0k tok compacted')
  expect([shortRange('week', periodSpan('week', at(11, 4))), shortRange('week', periodSpan('week', NOW)), shortRange('month', periodSpan('month', NOW))]).toEqual(['Nov 2 – 8', 'Oct 26 – Nov 1', 'Oct 2026'])
  const records = [rec('a', at(10, 27), { actualUsd: 0.2, baselineUsd: 1.2, tokensSaved: 9_000 }), rec('b', at(10, 28), { actualUsd: 0.4, baselineUsd: 0.2 }), rec('c', at(10, 20), { actualUsd: 0.1, baselineUsd: 0.6 })]
  expect(subLine(summarizePeriod(records, 'week', NOW, 0))).toBe('2 sessions · 1 cost more · ≈9.0k tok · vs last week +$0.300')
  expect(subLine(summarizePeriod(records, 'week', NOW, -1))).toBe('1 session')
  expect(subLine(summarizePeriod([], 'month', NOW, 0))).toBe('no sessions')
})

// The mod itself: what it writes to the history file as a session goes on, and the pane and command that read it.

function world(on: On, opts: { readFails?: boolean } = {}) {
  const files: Record<string, string> = {}
  let id = 'session-a'
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/home/dev/my-app' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }))
  const key = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.exists', ($, e) => ({ value: key(e.path) in files }))
  on('fs.read', ($, e) => {
    if (opts.readFails === true || !(key(e.path) in files)) {
      throw new Error(opts.readFails === true ? 'EACCES' : 'ENOENT')
    }
    return { value: files[key(e.path)]! } as never
  })
  on('fs.write', ($, e) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'HAIKU', usage: { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 50, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, model: e.model } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return {
    history: () => parseHistory(files['/home/dev/.claude/model-router/history.jsonl'] ?? ''),
    files,
    setId: (next: string) => (id = next),
  }
}

async function turn($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })) {
    // drained, so the request beneath runs
  }
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never)
}

const QUICK = 'Translate this error message into German: "File not found"'

test('each turn updates the session record, and /clear starts a new one', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/home/dev/my-app', surface: 'terminal', isInteractive: true })

  await turn($, QUICK)
  expect(w.history().map(r => [r.id, r.ledger.turns.haiku, r.project, r.model, r.prices])).toEqual([['session-a', 1, 'my-app', 'claude-opus-5-5', '2026-10']])
  const first = saved(w.history()[0]!.ledger)
  expect(first > 0).toBe(true)

  await turn($, QUICK)
  expect(w.history().length).toBe(1)
  expect(w.history()[0]!.ledger.turns.haiku).toBe(2)

  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: {} } as never)
  w.setId('session-b')
  await turn($, QUICK)
  const [a, b] = w.history()
  expect([a?.id, b?.id]).toEqual(['session-a', 'session-b'])
  expect(b?.ledger.turns.haiku).toBe(1)
  expect(a?.ledger.turns.haiku).toBe(2)
})

test('a history file that cannot be read is kept, not overwritten', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { readFails: true })
  w.files['/home/dev/.claude/model-router/history.jsonl'] = 'precious'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await turn($, QUICK)
  expect(w.files['/home/dev/.claude/model-router/history.jsonl']).toBe('precious')
})

test('/router stats and the pane read the history by week', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  const earlier = rec('session-0', at(10, 20, 10), { actualUsd: 0.5, baselineUsd: 0.2 })
  w.files['/home/dev/.claude/model-router/history.jsonl'] = `${JSON.stringify(earlier)}\nbroken line\n`
  await $.session.start({ cwd: '/home/dev/my-app', surface: 'terminal', isInteractive: true })
  await turn($, QUICK)
  expect(w.files['/home/dev/.claude/model-router/history.jsonl.bad']).toContain('broken line')

  const out = await $.command.run({ command: 'router', args: 'stats week', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toContain('this week · Oct 26 – Nov 1')
  expect(out.text).toContain('vs last week')
  const back = await $.command.run({ command: 'router-stats', args: 'week 1', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(back.text).toContain('last week · Oct 19 – Oct 25')
  expect(back.text).toContain('1 cost more')

  const pane = { plugin: 'model-router', component: 'Pane', requestId: 'model-router', props: { title: 'Model router' } as never } as const
  // Each look mounts the pane afresh, on both surfaces: what a press changed is the pane's state, not one drawing's.
  const shows = async (text: RegExp) => {
    const found: boolean[] = []
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...pane, surface })
      found.push((await ui.find({ type: 'Text', text })) !== undefined)
      await ui.unmount()
    }
    return found
  }
  const press = async (key: string) => {
    const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
    await ui.press({ key })
    await ui.unmount()
  }

  expect(await shows(/^This week$/)).toEqual([false, false])
  await press('view-week')
  expect(await shows(/^This week$/)).toEqual([true, true])
  expect(await shows(/^Oct 26 – Nov 1$/)).toEqual([true, true])
  expect(await shows(/^\+\$0\.\d{3}$/)).toEqual([true, true])
  expect(await shows(/^1 session · vs last week \+\$/)).toEqual([true, true])
  // Nothing that is zero is drawn: no crew, judge or compaction line in a week of routing alone.
  expect(await shows(/crew|judge|compact/)).toEqual([false, false])
  await press('period-prev')
  expect(await shows(/^Last week$/)).toEqual([true, true])
  expect(await shows(/^-\$0\.300$/)).toEqual([true, true])
  expect(await shows(/^1 session · 1 cost more$/)).toEqual([true, true])
  expect(await shows(/^routing -\$0\.300$/)).toEqual([true, true])
  // Back to the current week, and no further.
  await press('period-next')
  await press('period-prev')
  await press('period-next')
  expect(await shows(/^This week$/)).toEqual([true, true])
  await press('period-prev')
  await press('session-session-0')
  expect(await shows(/spent \$0\.500 instead of \$0\.200/)).toEqual([true, true])
  await press('view-session')
  expect(await shows(/^Haiku·low/)).toEqual([true, true])
})

test('a tool\'s progress lines compressed away count as tokens saved in the session record', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/home/dev/my-app', surface: 'terminal', isInteractive: true })

  const raw = Array.from({ length: 60 }, (_, i) => [`make[2]: Entering directory '/home/dev/my-app/lib/module-${i}'`, `cc -c m${i}.c`, `make[2]: Leaving directory '/home/dev/my-app/lib/module-${i}'`]).flat().join('\n')
  await $.tool.call({ tool: 'Bash', command: 'make all', tool_use_id: 'toolu_make' } as never)
  const stored = await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'row-make', message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_make', content: raw }] } })
  const text = String((stored as { message?: { content: { content?: unknown }[] } }).message?.content[0]?.content)
  expect(text).toContain('(120 progress lines hidden)')
  expect(text).toContain('cc -c m59.c')

  await turn($, QUICK)
  const [record] = w.history()
  expect(record?.ledger.compressions).toBe(1)
  expect((record?.ledger.tokensSaved ?? 0) > 1_000).toBe(true)
  expect(record?.ledger.tokensSaved).toBe(Math.round((raw.length - (record?.ledger.keptChars ?? 0)) / 4))
})
