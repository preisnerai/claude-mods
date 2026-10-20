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
  on('command.register', () => ({ value: { command: 'router' } }))
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

type Stored = { message?: { content: { content?: unknown }[] } }

function storedText(row: Stored) {
  return row.message?.content[0]?.content
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

test('a clear prompt routes by the local rules, with no judge call', async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Translate this error message into German: "File not found"')
  await step($)

  expect(w.judged.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
})

test('an unclear prompt asks the Haiku judge', async ($, on) => {
  const w = world(on, { judge: 'SONNET' })
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.judged[0]).toContain('<request>\nHelp me with my thing in the app.\n</request>')
  expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

test('with the judge off, an unclear prompt keeps /model', { options: { judge: 'off' } }, async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(0)
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('a session on a variant of the routed tier keeps its own id', async ($, on) => {
  const w = world(on, { model: 'claude-opus-5-5[1m]' })
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  await step($, undefined, 'claude-opus-5-5[1m]')

  // Its own tier: the request goes out exactly as the session made it, effort included.
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5[1m]', effort: 'xhigh' }])
})

test('with laya-serve set up, unclear prompts are classified there, for no tokens', { options: { layaUrl: 'http://localhost:8000/' } }, async ($, on) => {
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

test('an unsure laya-serve hands the prompt to the judge', { options: { layaUrl: 'http://localhost:8000' } }, async ($, on) => {
  const w = world(on, { judge: 'SONNET' })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { route: { choice: 'trivial', answer_confidence: 0.4 } } }) } }))
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
})

test('a !tier prefix forces the model and is stripped', async ($, on) => {
  const w = world(on)
  await start($)

  const entered = await submit($, '!opus rename usr to user')
  await step($)

  expect(entered.text).toBe('rename usr to user')
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
})

test('a short follow-up keeps the route, an easy task on a short context drops to Haiku', async ($, on) => {
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

test('Opus does not drop to Sonnet when the cached conversation is worth more than the switch saves', async ($, on) => {
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

test('once the cache has lapsed, the same switch goes through', async ($, on) => {
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

test('/clear keeps only the system prompt cached, so a long conversation no longer holds a quick task back', async ($, on) => {
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

test('with 5-minute cache entries, ten idle minutes are enough to lapse it', { options: { cacheTtl: '5m' } }, async ($, on) => {
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

test('a harder task escalates under escalate: auto', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'Fix the typo "recieve" everywhere in the repo')
  w.setContext(30_000)
  await step($)
  await submit($, 'Why does the worker hang after a rebalance? Investigate.')
  await step($)
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('suggest mode leaves the model and names the tier', { options: { escalate: 'suggest' } }, async ($, on) => {
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

test('/model by hand turns routing off until /router on', async ($, on) => {
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

test('a cheap turn hands its model to general-purpose subagents; agent types that may pin a model are left alone', async ($, on) => {
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

test('three failing tool calls in a row escalate one tier for the rest of the turn', async ($, on) => {
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

test('Bash output is compressed before it is stored, and kept whole on disk', async ($, on) => {
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
  expect(w.written['/home/dev/.claude/model-router/tee/0.txt']).toBe(`# model-router: full output of toolu_1: npm test\n${raw}`)
  expect(text.length < raw.length / 10).toBe(true)

  const report = await router($, '')
  expect(report.text).toContain('bash output | 1×')
})

test('file contents read through Bash reach the model verbatim', async ($, on) => {
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

test("Claude Code's own preview of a huge output is left as it is", async ($, on) => {
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

test('the answer style is one section at the end of the system prompt', async ($, on) => {
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

test('/router reports savings against the model each step would have run on', async ($, on) => {
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

test('escalate: suggest holds even on the first prompt, when nothing is cached yet', { options: { escalate: 'suggest' } }, async ($, on) => {
  const w = world(on, { model: 'claude-haiku-5-5' })
  await start($)

  await submit($, 'Why does the worker hang after a rebalance? Investigate.')
  await step($, undefined, 'claude-haiku-5-5')

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5'])
  expect(w.statuses.at(-1)).toContain('consider !opus')
})

test('a skill is routed by what was typed and what the command says it does, not by its instructions', async ($, on) => {
  const w = world(on, { judge: 'HAIKU', commands: [{ name: 'pdf', description: 'Merge, split and rotate PDF files', source: 'user' }] })
  await start($)

  await $.prompt.submit({ text: '/pdf merge a.pdf and b.pdf', wait: false, origin: { kind: 'composer' }, command: { name: 'pdf', args: 'merge a.pdf and b.pdf' } } as never)
  await step($)

  expect(w.judged.length).toBe(1)
  expect(w.judged[0]).toContain('merge a.pdf and b.pdf\n(Merge, split and rotate PDF files)')
  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5'])
})

test('a prompt typed during a turn is routed when its own turn starts', async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, 'Translate this error message into German please')
  await step($)
  await $.prompt.submit({ text: 'Why does this deadlock only under load?', wait: true, origin: { kind: 'composer' }, turnId: 't1' } as never)
  await $.turn.start({ text: 'Why does this deadlock only under load?', turnId: 't2' })
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('the engine falling back to another model pauses routing; /model by hand stops it', async ($, on) => {
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

test('/resume forgets the other conversation: its cache, its route, its /model', async ($, on) => {
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

test('a compaction leaves the context its summary measures', async ($, on) => {
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

test('changing the style re-writes every cache, so a switch held for the cache goes through', async ($, on) => {
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

test("savings count a switch's own cache write: measured against the session model's warm cache", async ($, on) => {
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

test('two results stored at once get two tee files, and a result saving under 10% with its note goes as it came', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const big = (n: number) => [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${n}-${i} passes (1 ms)`), `FAIL src/${n}.test.ts`].join('\n')
  const append = (id: string, content: string) =>
    $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: id, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'a' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b' } as never)
  await Promise.all([append('a', big(1)), append('b', big(2))])
  expect(Object.keys(w.written).sort()).toEqual(['/home/dev/.claude/model-router/tee/0.txt', '/home/dev/.claude/model-router/tee/1.txt'])

  // 30 passing lines out of a 1.3k output: under 10% once the note is added.
  const small = [...Array.from({ length: 3 }, (_, i) => `  ✓ c${i}`), ...Array.from({ length: 40 }, (_, i) => `log line ${i} ${'z'.repeat(20)}`)].join('\n')
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'c' } as never)
  const stored = await append('c', small)
  expect(storedText(stored as Stored)).toBe(small)
})

test("Claude Code's own prompt commands run on your /model, not on the last prompt's cheaper tier", async ($, on) => {
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

test('results stored at the same moment are all counted in the all-time totals', async ($, on) => {
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

test('a short prompt the rules read is a new task, not a follow-up', async ($, on) => {
  const w = world(on)
  await start($)

  await submit($, '!haiku rename usr to user')
  await step($)
  await submit($, 'debug flaky test')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('with routing off a !tier prefix is removed and the status says it was ignored', async ($, on) => {
  const w = world(on)
  await start($)

  await router($, 'off')
  const entered = await submit($, '!opus redesign the plugin loader')
  await step($)

  expect(entered.text).toBe('redesign the plugin loader')
  expect(w.statuses.at(-1)).toContain('!opus was ignored')
  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
})

test('a judge that gives no answer leaves the prompt on /model and says why in the log', async ($, on) => {
  const w = world(on, { judgeFails: true })
  await start($)

  await submit($, 'Help me with my thing in the app.')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
  expect(w.statuses.at(-1)).toContain('unsure, using /model')
  expect((await router($, 'log')).text).toContain('"reason":"empty-reply"')
})

test('a laya-serve that hangs is given four seconds, then the judge decides', { options: { layaUrl: 'http://localhost:8000' } }, async ($, on) => {
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

test('a result made of text blocks is compressed as blocks', async ($, on) => {
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

test('the tee ring wraps after its last slot', async ($, on) => {
  const w = world(on, { store: { teeSlot: 199 } })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await start($)

  const big = (n: number) => [...Array.from({ length: 400 }, (_, i) => `  ✓ case ${n}-${i} passes (1 ms)`), `FAIL src/${n}.test.ts`].join('\n')
  for (const id of ['r1', 'r2']) {
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: id } as never)
    await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: id, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: big(id.length) }] } })
  }
  expect(Object.keys(w.written).sort()).toEqual(['/home/dev/.claude/model-router/tee/0.txt', '/home/dev/.claude/model-router/tee/199.txt'])
})
