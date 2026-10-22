import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

// Stands in for the session: its /model, the judge, the status line and the requests beneath the plugin.
function world(on: On, opts: { judge?: string; judgeFails?: boolean; model?: string; store?: Record<string, unknown>; commands?: { name: string; description: string; source: string }[] } = {}) {
  const sent: { model: string; effort?: unknown }[] = []
  const judged: string[] = []
  const statuses: (string | undefined)[] = []
  const written: Record<string, string> = {}
  let sessionModel = opts.model ?? 'claude-opus-5-5'
  let usage: TurnUsage | null = null

  mock.store(on, opts.store)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.model', () => ({ value: sessionModel }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-0123456789' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.list', () => ({ value: (opts.commands ?? []) as never }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }))
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', ($, e) => {
    judged.push(e.prompt)
    if (opts.judgeFails === true) {
      return { value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 300, output_tokens: 64, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    }
    return { value: { isAnswered: true, text: opts.judge ?? 'OPUS', usage: { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage === null ? null : { ...usage, model: e.model } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('classic.PostModelSwitch', () => ({}))

  return {
    sent,
    judged,
    statuses,
    written,
    clock,
    setModel: (m: string) => (sessionModel = m),
    /** The context each later request reports, as the API's usage would. */
    setContext: (tokens: number) => (usage = { input_tokens: 50, output_tokens: 500, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, model: '' }),
    setUsage: (u: Omit<TurnUsage, 'model'>) => (usage = { ...u, model: '' }),
  }
}

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

function router($: Engine, args: string) {
  return $.command.run({ command: 'router', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

function command($: Engine, name: string, args = '') {
  return $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

type Stored = { message?: { content: { content?: unknown }[] } }

function storedText(row: Stored) {
  return row.message?.content[0]?.content
}

// The engine resolves a written path against the host drive: compare its tail, not its separator.
function writtenTail(written: Record<string, string>, path: string): string | undefined {
  const key = Object.keys(written).find(k => k.replace(/\\/g, '/').endsWith(path))
  return key === undefined ? undefined : written[key]
}

function teeFiles(written: Record<string, string>): string[] {
  return Object.keys(written)
    .map(k => k.replace(/\\/g, '/'))
    .map(k => k.slice(k.indexOf('/model-router/tee/')))
    .filter(k => k.startsWith('/model-router/tee/'))
    .sort()
}

function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, agentId?: string, model = 'claude-opus-5-5') {
  const stream = $.turn.step({ turnId: 't', index: 0, model, effort: 'xhigh', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drained, so the request beneath runs
  }
}

test('a clear prompt routes by the local rules, with no judge call', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Translate this error message into German: "File not found"')
  await step($)

  expect(w.judged.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('an unclear prompt asks the Haiku judge', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { judge: 'SONNET' })
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.judged[0]).toContain('<request>\nHelp me with my thing in the app.\n</request>')
  expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

test('with the judge off, an unclear prompt keeps /model', { options: { mode: 'route', judge: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('a session on a variant of the routed tier keeps its own id', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { model: 'claude-opus-5-5[1m]' })
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  await step($, undefined, 'claude-opus-5-5[1m]')

  // Its own tier: the request goes out exactly as the session made it, effort included.
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5[1m]', effort: 'xhigh' }])
})

test('with laya-serve set up, unclear prompts are classified there, for no tokens', { options: { mode: 'route', layaUrl: 'http://localhost:8000/' } }, async ($, on) => {
  const w = world(on)
  const asked: string[] = []
  on('http.fetch', ($, e) => {
    asked.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { route: { choice: 'trivial', answer_confidence: 0.9 } } }) } }
  })
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(asked).toEqual(['http://localhost:8000/v1/systemone'])
  expect(w.judged.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('an unsure laya-serve hands the prompt to the judge', { options: { mode: 'route', layaUrl: 'http://localhost:8000' } }, async ($, on) => {
  const w = world(on, { judge: 'SONNET' })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { route: { choice: 'trivial', answer_confidence: 0.4 } } }) } }))
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

test('a !tier prefix forces the model and is stripped', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  const entered = await submit($, '!opus rename usr to user')
  await step($)

  expect(entered.text).toBe('rename usr to user')
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('a short follow-up keeps the route, an easy task on a short context drops to Haiku', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  await step($)
  w.setContext(20_000)
  await step($)
  await submit($, 'ok')
  await step($)
  await submit($, 'Translate the error message into Polish please')
  await step($)

  expect(w.judged.length).toBe(0)
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'])
})

test('Opus does not drop to Sonnet when the cached conversation is worth more than the switch saves', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setContext(400_000)
  await step($)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(w.statuses.at(-1)).toContain('switching costs')

  const report = await router($, '')
  expect(report.text).toContain('switches / holds | 0 / 1')
})

test('once the cache has lapsed, the same switch goes through', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setContext(400_000)
  await step($)
  await w.clock.advance(61 * 60_000)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
})

test('/clear keeps only the system prompt cached, so a long conversation no longer holds a quick task back', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)

  w.setContext(30_000) // the first request: system prompt, tools, prompt
  await submit($, 'Why does this deadlock only under load?')
  await step($)
  w.setContext(400_000)
  await step($)
  // Past 100K tokens Haiku bills its long-context rate: a warm Opus is cheaper.
  await submit($, 'Translate this error message into German please')
  await step($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await submit($, 'Translate this error message into German please')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'])
})

test('with 5-minute cache entries, ten idle minutes are enough to lapse it', { options: { mode: 'route', cacheTtl: '5m' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setContext(400_000)
  await step($)
  await w.clock.advance(10 * 60_000)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
})

test('a harder task escalates under escalate: auto', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'Fix the typo "recieve" everywhere in the repo')
  w.setContext(30_000)
  await step($)
  await submit($, 'Why does the worker hang after a rebalance? Investigate.')
  await step($)
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('suggest mode leaves the model and names the tier', { options: { mode: 'route', escalate: 'suggest' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'Fix the typo "recieve" everywhere in the repo')
  w.setContext(30_000)
  await step($)
  await submit($, 'Why does the worker hang after a rebalance? Investigate.')
  await step($)
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  expect(w.statuses.at(-1)).toContain('consider !opus')
})

test('/model by hand turns routing off until /router on', { options: { mode: 'route', adapt: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Translate this sentence into French for me')
  await step($)
  w.setModel('claude-sonnet-5-5')
  await step($)
  await submit($, 'Translate another sentence into French for me')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])

  await router($, 'on')
  await submit($, 'Translate a third sentence into French for me')
  await step($)
  expect(w.sent.at(-1)?.model).toBe('claude-haiku-5-5')
})

test('a cheap turn hands its model to general-purpose subagents; agent types that may pin a model are left alone', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ agentId: 'a1', model: e.model ?? e.parentModel }))
  await start($)

  await submit($, 'Add unit tests for the date formatting helpers')
  await step($, 'agent-1')
  await step($)
  const spawn = (subagentType: string) => $.agent.spawn({ prompt: 'look around', description: 'explore', subagentType, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', tool_use_id: 'tu' } as never)
  const spawned = await spawn('general-purpose')
  const pinned = await spawn('Explore')

  expect(w.sent).toEqual([
    { model: 'claude-opus-5-5', effort: 'xhigh' },
    { model: 'claude-sonnet-5-5', effort: 'medium' },
  ])
  expect((spawned as { model?: string }).model).toBe('claude-sonnet-5-5')
  expect((pinned as { model?: string }).model).toBe('claude-opus-5-5')
})

test('three failing tool calls in a row escalate one tier for the rest of the turn', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ isError: true, result: 'boom', text: 'boom' }))
  await start($)

  await submit($, 'Add unit tests for the date formatting helpers')
  await step($)
  for (const n of [1, 2, 3]) {
    await $.tool.call({ tool: 'Bash', command: `npm test -- run ${n}` })
  }
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect(w.statuses.at(-1)).toContain('tools keep failing → Opus')
})

test('Bash output is compressed before it is stored, and kept whole on disk', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const raw = [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${i} passes (1 ms)`), 'FAIL src/b.test.ts', '  Expected: 53', '  Received: 52', 'Tests: 1 failed, 400 passed'].join('\n')
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' } as never)
  const stored = await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'row-1',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: raw }] },
  })

  const text = String(storedText(stored as Stored))
  expect(text).toContain('Received: 52')
  expect(text).toContain('(400 passing test lines hidden)')
  expect(text).toContain("full output: '/home/dev/.claude/model-router/tee/0.txt'")
  expect(writtenTail(w.written, '/home/dev/.claude/model-router/tee/0.txt')).toBe(`# model-router: full output of toolu_1: npm test\n${raw}`)
  expect(text.length < raw.length / 10).toBe(true)

  const report = await router($, '')
  expect(report.text).toContain('bash output | 1×')
})

test('file contents read through Bash reach the model verbatim', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const raw = Array.from({ length: 400 }, () => 'const x = 1').join('\n')
  await $.tool.call({ tool: 'Bash', command: 'cat src/x.ts', tool_use_id: 'toolu_2' } as never)
  const stored = await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'row-2',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: raw }] },
  })
  expect(storedText(stored as Stored)).toBe(raw)
})

test("Claude Code's own preview of a huge output is left as it is", { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const raw = `<persisted-output>\nOutput too large (63.4KB). Full output saved to: /x/tool-results/a.txt\n\nPreview (first 2KB):\n${Array.from({ length: 100 }, (_, i) => `record ${i}`).join('\n')}\n...\n</persisted-output>`
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_3' } as never)
  const stored = await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'row-3',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: raw }] },
  })
  expect(storedText(stored as Stored)).toBe(raw)
})

test('the answer style is one section at the end of the system prompt', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await start($)

  const terse = await $.prompt.compose(COMPOSE)
  expect(terse.sections.map(s => s.id)).toEqual(['intro', 'model-router:style'])
  expect(terse.sections.at(-1)?.text).toContain('Output economy')

  await router($, 'style adhd')
  expect((await $.prompt.compose(COMPOSE)).sections.at(-1)?.text).toContain('ADHD-friendly output')

  await router($, 'style off')
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro'])
})

test('/router reports savings against the model each step would have run on', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Translate this error message into German: "File not found"')
  w.setContext(10_000)
  await step($)
  await $.turn.complete({ turnId: 't', answer: 'Datei nicht gefunden', durationMs: 1, isAborted: false, reason: 'answer' } as never)

  const report = await router($, '')
  expect(report.text).toContain('Haiku 1')
  expect(report.text).toMatch(/saved vs claude-opus-5-5 \| ≈\$0\.\d{3}: \$0\.000\d spent instead of \$0\.\d{3}, 1 requests routed/)
})

test('escalate: suggest holds even on the first prompt, when nothing is cached yet', { options: { mode: 'route', escalate: 'suggest' } }, async ($, on) => {
  const w = world(on, { model: 'claude-haiku-5-5' })
  await start($)

  await submit($, 'Why does the worker hang after a rebalance? Investigate.')
  await step($, undefined, 'claude-haiku-5-5')

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5'])
  expect(w.statuses.at(-1)).toContain('consider !opus')
})

test('a skill is routed by what was typed and what the command says it does, not by its instructions', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { judge: 'HAIKU', commands: [{ name: 'pdf', description: 'Merge, split and rotate PDF files', source: 'user' }] })
  await start($)

  await $.prompt.submit({ text: '/pdf merge a.pdf and b.pdf', wait: false, origin: { kind: 'composer' }, command: { name: 'pdf', args: 'merge a.pdf and b.pdf' } } as never)
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.judged[0]).toContain('merge a.pdf and b.pdf\n(Merge, split and rotate PDF files)')
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5'])
})

test('a prompt typed during a turn is routed when its own turn starts', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Translate this error message into German please')
  await step($)
  await $.prompt.submit({ text: 'Why does this deadlock only under load?', wait: true, origin: { kind: 'composer' }, turnId: 't1' } as never)
  await $.turn.start({ text: 'Why does this deadlock only under load?', turnId: 't2' })
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('the engine falling back to another model pauses routing; /model by hand stops it', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)
  const fields = { from_model: 'claude-opus-5-5', requested_model: null, context_tokens: 0, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 0 }

  await submit($, 'Translate this error message into German please')
  await step($)
  w.setModel('claude-sonnet-5-5')
  await $.classic.PostModelSwitch({ ...fields, to_model: 'claude-sonnet-5-5', source: 'auto' } as never)
  await step($, undefined, 'claude-sonnet-5-5')
  await submit($, 'Translate another error message into German please')
  await step($, undefined, 'claude-sonnet-5-5')

  w.setModel('claude-opus-5-5')
  await $.classic.PostModelSwitch({ ...fields, from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', source: 'command' } as never)
  await submit($, 'Translate a third error message into German please')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])
})

test('/resume forgets the other conversation: its cache, its route, its /model', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)

  w.setContext(30_000)
  await submit($, 'Why does this deadlock only under load?')
  await step($)
  w.setContext(400_000)
  await step($)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
  w.setModel('claude-sonnet-5-5')
  await submit($, 'Translate this error message into German please')
  await step($, undefined, 'claude-sonnet-5-5')

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'])
})

test('a compaction leaves the context its summary measures', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 20_000 }) as never)
  await start($)

  w.setContext(30_000)
  await submit($, 'Why does this deadlock only under load?')
  await step($)
  w.setContext(400_000)
  await step($)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'all of it', toolUses: [] }] } as never)
  await submit($, 'Translate this error message into German please')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'])
})

test('changing the style re-writes every cache, so a switch held for the cache goes through', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setContext(100_000)
  await step($)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)
  await router($, 'style adhd')
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
})

test("savings count a switch's own cache write: measured against the session model's warm cache", { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setUsage({ input_tokens: 0, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000 })
  await step($)
  await submit($, 'Translate this error message into German please')
  w.setUsage({ input_tokens: 0, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 51_000 })
  await step($)

  // Step 2 on Haiku wrote 51k (0.1 x 2 per MTok) and wrote 1k of output (0.5); on Opus it would have read the 50k it
  // had cached (0.2), written 1k new (4 x 2) and written the same 1k of output (20). Step 1 is the same on both.
  const actual = (51_000 * 0.2 + 1_000 * 0.5) / 1e6
  const baseline = (50_000 * 0.2 + 1_000 * 8 + 1_000 * 20) / 1e6
  const report = await router($, '')
  expect(report.text).toContain(`saved vs claude-opus-5-5 | ≈$${(baseline - actual).toFixed(3)}`)
})

test('two results stored at once get two tee files, and a result saving under 10% with its note goes as it came', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const big = (n: number) => [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${n}-${i} passes (1 ms)`), `FAIL src/${n}.test.ts`].join('\n')
  const append = (id: string, content: string) =>
    $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: id, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'a' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b' } as never)
  await Promise.all([append('a', big(1)), append('b', big(2))])
  expect(teeFiles(w.written)).toEqual(['/model-router/tee/0.txt', '/model-router/tee/1.txt'])

  // 30 passing lines out of a 1.3k output: under 10% once the note is added.
  const small = [...Array.from({ length: 3 }, (_, i) => `  ✓ c${i}`), ...Array.from({ length: 40 }, (_, i) => `log line ${i} ${'z'.repeat(20)}`)].join('\n')
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'c' } as never)
  const stored = await append('c', small)
  expect(storedText(stored as Stored)).toBe(small)
})

test("Claude Code's own prompt commands run on your /model, not on the last prompt's cheaper tier", { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { commands: [{ name: 'code-review', description: 'Review the current diff', source: 'builtin' }] })
  await start($)

  await submit($, 'Translate this error message into German please')
  await step($)
  await $.prompt.submit({ text: '/code-review high', wait: false, origin: { kind: 'composer' }, command: { name: 'code-review', args: 'high' } } as never)
  await step($)

  expect(w.sent).toEqual([
    { model: 'claude-haiku-5-5', effort: 'low' },
    { model: 'claude-opus-5-5', effort: 'xhigh' },
  ])
})

test('results stored at the same moment are all counted in the all-time totals', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const big = (n: number) => [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${n}-${i} passes (1 ms)`), `FAIL src/${n}.test.ts`].join('\n')
  const ids = ['p1', 'p2', 'p3', 'p4']
  for (const id of ids) {
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: id } as never)
  }
  await Promise.all(ids.map((id, n) => $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: id, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: big(n) }] } })))

  const report = await router($, '')
  expect(report.text).toMatch(/\| bash output \| 4× .* \| 4× /)
})

test('a short prompt the rules read is a new task, not a follow-up', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, '!haiku rename usr to user')
  await step($)
  await submit($, 'debug flaky test')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('with routing off a !tier prefix is removed and the status says it was ignored', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await router($, 'off')
  const entered = await submit($, '!opus redesign the plugin loader')
  await step($)

  expect(entered.text).toBe('redesign the plugin loader')
  expect(w.statuses.at(-1)).toContain('!opus was ignored')
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
})

test('a judge that gives no answer leaves the prompt on /model and says why in the log', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { judgeFails: true })
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
  expect(w.statuses.at(-1)).toContain('unsure, using /model')
  expect((await router($, 'log')).text).toContain('"reason":"empty-reply"')
})

test('a laya-serve that hangs is given four seconds, then the judge decides', { options: { mode: 'route', layaUrl: 'http://localhost:8000' } }, async ($, on) => {
  const w = world(on, { judge: 'SONNET' })
  on('http.fetch', () => new Promise(() => {}))
  await start($)

  const entering = submit($, 'Help me with my thing in the app.')
  await w.clock.advance(4_000)
  await entering
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
})

test('a result made of text blocks is compressed as blocks', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const raw = [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${i} passes (1 ms)`), 'FAIL src/b.test.ts'].join('\n')
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'blk' } as never)
  const stored = await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'blk',
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'blk', content: [{ type: 'text', text: raw }] }] },
  })
  const content = (stored as { message?: { content: { content?: unknown }[] } }).message?.content[0]?.content as { type: string; text: string }[]
  expect(content.length).toBe(1)
  expect(content[0]?.type).toBe('text')
  expect(content[0]?.text).toContain('(400 passing test lines hidden)')
})

test('the tee ring wraps after its last slot', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { store: { teeSlot: 199 } })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const big = (n: number) => [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${n}-${i} passes (1 ms)`), `FAIL src/${n}.test.ts`].join('\n')
  for (const id of ['r1', 'r2']) {
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: id } as never)
    await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: id, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: big(id.length) }] } })
  }
  expect(teeFiles(w.written)).toEqual(['/model-router/tee/0.txt', '/model-router/tee/199.txt'])
})

test('the pane shows the route and the savings', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  await start($)
  await submit($, 'Translate this error message into German: "File not found"')
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', component: 'Pane', requestId: 'model-router', props: { title: 'Model router' } as never, surface })
    expect((await ui.find({ type: 'Text', text: /^Haiku·low/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^saved/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

const HARD = 'Why does the checkout service crash intermittently? Investigate the root cause.'

test('the router never sends max, even when a setting asks for it', { options: { mode: 'route', opusEffort: 'max', escalate: 'auto' } }, async ($, on) => {
  const w = world(on, { model: 'claude-haiku-5-5' })
  await start($)

  await submit($, HARD)
  await step($, undefined, 'claude-haiku-5-5')

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('effort is picked per task: a wide change on your own Opus goes at high while nothing is cached', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Update every caller across the monorepo')
  await step($)

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('an effort change on your own model passes the cache math: a warm cache keeps your /effort', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)
  w.setContext(60_000)

  await submit($, 'hi')
  await step($)
  await submit($, 'Update every caller across the monorepo')
  await step($)

  expect(w.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
})

test('after a task went out at its own effort, the next prompt is priced from that warm cache, not from your /effort', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Update every caller across the monorepo')
  await step($)
  w.setContext(60_000)
  await submit($, 'hi')
  await step($)

  expect(w.sent.map(s => s.effort)).toEqual(['high', 'high'])
})

test('effortMode fixed keeps the tier effort', { options: { mode: 'route', effortMode: 'fixed' } }, async ($, on) => {
  const w = world(on, { model: 'claude-haiku-5-5' })
  await start($)

  await submit($, HARD)
  await step($, undefined, 'claude-haiku-5-5')

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
})

test('ultracode suggest names it in the status line and leaves the prompt alone', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  const out = await submit($, HARD)

  expect(w.statuses.at(-1)).toContain("add 'ultracode'")
  expect((out as { text?: string }).text).toBe(HARD)
})

test('ultracode auto adds the keyword to a hard prompt, once, and not to an easy one', { options: { mode: 'route', ultracode: 'auto' } }, async ($, on) => {
  world(on)
  await start($)

  expect(((await submit($, HARD)) as { text?: string }).text).toBe(`${HARD}\n\nultracode`)
  expect(((await submit($, `${HARD} ultracode`)) as { text?: string }).text).toBe(`${HARD} ultracode`)
  expect(((await submit($, 'Translate this sentence into French for me')) as { text?: string }).text).toBe('Translate this sentence into French for me')
})

test('ultracode off says nothing', { options: { mode: 'route', ultracode: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($)

  const out = await submit($, HARD)

  expect(w.statuses.some(s => s?.includes('ultracode'))).toBe(false)
  expect((out as { text?: string }).text).toBe(HARD)
})

test('a !tier override is learned for that kind of task, shown, fades and is reset', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, '!sonnet Translate this sentence into French for me')
  await step($)
  await submit($, 'Translate another sentence into French for me')
  await step($)
  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  expect((await router($, '')).text).toContain('learned: translation +1 tier')

  // Two months later the correction has faded.
  await w.clock.advance(60 * 24 * 60 * 60_000)
  await submit($, 'Translate a third sentence into French for me')
  await step($)
  expect(w.sent.at(-1)?.model).toBe('claude-haiku-5-5')

  await submit($, '!sonnet Translate this sentence into French for me')
  await router($, 'reset')
  expect((await router($, '')).text).toContain('learned: nothing yet')
})

test('with adapt off nothing is learned', { options: { mode: 'route', adapt: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, '!sonnet Translate this sentence into French for me')
  await step($)
  await submit($, 'Translate another sentence into French for me')
  await step($)
  expect(w.sent.at(-1)?.model).toBe('claude-haiku-5-5')
})

test('!+ lifts the current route one tier and !- lowers it', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, '!haiku rename usr to user')
  await step($)
  const up = await submit($, '!+ add a dark mode toggle to the settings page')
  await step($)
  const down = await submit($, '!- translate this error message into German')
  await step($)

  expect(up.text).toBe('add a dark mode toggle to the settings page')
  expect(down.text).toBe('translate this error message into German')
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
})

test('!+ at the top tier says so and leaves the model alone', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  const entered = await submit($, '!+ refactor the auth module')
  await step($)

  expect(entered.text).toBe('refactor the auth module')
  expect(w.statuses.at(-1)).toContain('already at the strongest tier')
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
})

test('dissatisfaction escalates one tier above the current route', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)
  await submit($, 'znowu źle')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect((await router($, 'why')).text).toContain('dissatisfied')
})

test('/router why explains a cache hold and the decision log lands on disk', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setContext(400_000)
  await step($)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  const why = await router($, 'why')
  expect(why.text).toContain('stayed on Opus')
  expect(why.text).toContain('cache math')
  expect(why.text).toMatch(/cache re-write of \d+k tokens/)

  const log = writtenTail(w.written, '/home/dev/.claude/model-router/decisions.json')
  expect(log).toContain('"event": "route"')
  expect(log).toContain('"tier": "sonnet"')
  expect(log).toContain('"taken": false')
})

test('a judge below the confidence floor leaves the model on /model and /router why says why', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on, { judge: 'SONNET confidence 0.2' })
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
  expect((await router($, 'why')).text).toContain('no local rule or judge')
})

test('non-code work routes without the judge', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Przygotuj arkusz Excel z podsumowaniem sprzedaży za Q3')
  await step($)

  expect(w.judged.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

test('an effort change on your own model is priced like a model switch: a warm cache keeps Extra', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'hi')
  w.setContext(60_000)
  await step($)
  await submit($, 'Update every caller across the monorepo')
  await step($)

  expect(w.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
  expect(w.statuses.at(-1)).toContain('task wanted high, kept Extra (cache)')
  expect((await router($, 'why')).text).toContain('task wanted high, kept Extra (cache)')
})

test('!+ teaches the router that this kind of task wants more', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)
  await submit($, '!+ add another settings toggle')
  await step($)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
  expect((await router($, '')).text).toContain('learned: bounded feature +1 tier')
})

test('effortMode task takes the task effort even when a warm cache would hold it', { options: { mode: 'route', effortMode: 'task' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'hi')
  w.setContext(60_000)
  await step($)
  await submit($, 'Update every caller across the monorepo')
  await step($)

  expect(w.sent.map(s => s.effort)).toEqual(['xhigh', 'high'])
  expect(w.statuses.at(-1)).toContain('effort high for this task')
})

test('/router-help is the directory of every command and says what each is for', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  await start($)

  const help = await command($, 'router-help')
  const described: [string, string][] = [
    ['/router', 'current route, savings'],
    ['/router-help', 'this list'],
    ['/router-start', 'turn routing on'],
    ['/router-why', 'last model/effort decision'],
    ['/router-effort', 'effort policy'],
    ['/router-ultracode', 'Ultracode: `suggest`'],
    ['/router-log', 'JSON'],
    ['/router-panel', 'live pane'],
    ['/router-style', 'answer style'],
    ['/router-off', 'stop routing'],
    ['/router-on', 'resume routing'],
    ['/router-reset', 'clear totals'],
  ]
  for (const [name, description] of described) {
    expect({ name, listed: help.text.includes(name), described: help.text.includes(description) }).toEqual({ name, listed: true, described: true })
  }
  for (const sub of ['/router help', '/router start', '/router why', '/router effort', '/router ultracode', '/router log', '/router panel', '/router style', '/router off', '/router on', '/router reset']) {
    expect(help.text).toContain(sub)
  }
})

test('/router-start turns routing on and says what is active', { options: { mode: 'route' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await command($, 'router-off')

  const started = await command($, 'router-start')
  expect(started.text).toContain('ready')
  expect(started.text).toContain('effort auto')

  await submit($, 'Translate this error message into German please')
  await step($)
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5'])
})

test('/router-effort shows the policy and sets the session mode', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  await start($)

  const shown = await command($, 'router-effort')
  expect(shown.text).toContain('effort — auto')
  expect(shown.text).toContain('never sends Max or Ultracode')

  const set = await command($, 'router-effort', 'task')
  expect(set.text).toContain('effort mode task')
  expect((await router($, '')).text).toContain('effort task')
})

test('command aliases reach the same handlers', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  await start($)
  await submit($, 'Translate this error message into German please')
  await step($)

  expect((await command($, 'router-why')).text).toContain('translation')
  expect((await command($, 'router-log')).text).toContain('"event":"route"')
  expect((await command($, 'router-panel')).text).toContain('pane opened')

  await command($, 'router-style', 'adhd')
  expect((await command($, 'router-style')).text).toContain('style is adhd')

  await command($, 'router-off')
  expect((await command($, 'router-on')).text).toContain('routing on')
})

test('/router-ultracode shows and sets the mode', { options: { mode: 'route' } }, async ($, on) => {
  world(on)
  await start($)

  const shown = await command($, 'router-ultracode')
  expect(shown.text).toContain('suggest')

  const set = await command($, 'router-ultracode', 'auto')
  expect(set.text).toContain('ultracode auto')

  const entered = await submit($, HARD)
  expect((entered as { text?: string }).text).toContain('ultracode')
  expect((await router($, '')).text).toContain('ultracode auto')
})
