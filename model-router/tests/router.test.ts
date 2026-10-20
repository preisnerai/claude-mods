import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

// Stands in for the session: its /model, the judge, the status line and the requests beneath the plugin.
function world(on: On, opts: { judge?: string; model?: string } = {}) {
  const sent: { model: string; effort?: unknown }[] = []
  const judged: string[] = []
  const statuses: (string | undefined)[] = []
  const written: Record<string, string> = {}
  let sessionModel = opts.model ?? 'claude-opus-5-5'
  let usage: TurnUsage | null = null

  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.model', () => ({ value: sessionModel }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-0123456789' }))
  on('command.register', () => ({ value: { command: 'router' } }))
  on('command.list', () => ({ value: [] }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }))
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', ($, e) => {
    judged.push(e.prompt)
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

  return {
    sent,
    judged,
    statuses,
    written,
    clock,
    setModel: (m: string) => (sessionModel = m),
    /** The context each later request reports, as the API's usage would. */
    setContext: (tokens: number) => (usage = { input_tokens: 50, output_tokens: 500, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, model: '' }),
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

  expect(w.sent).toEqual([{ model: 'claude-opus-5-5[1m]', effort: 'high' }])
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
  expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
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

test('/clear forgets the cached conversation, so the next prompt routes freely', async ($, on) => {
  const w = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  w.setContext(400_000)
  await step($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await submit($, 'Add a dark mode toggle to the settings page')
  await step($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
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

test('subagents keep their own model; a cheap turn hands its model to subagents that name none', async ($, on) => {
  const w = world(on)
  on('agent.spawn', ($, e) => ({ agentId: 'a1', model: e.model ?? e.parentModel }))
  await start($)

  await submit($, 'Add unit tests for the date formatting helpers')
  await step($, 'agent-1')
  await step($)
  const spawned = await $.agent.spawn({ prompt: 'look around', description: 'explore', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', tool_use_id: 'tu' } as never)

  expect(w.sent).toEqual([
    { model: 'claude-opus-5-5', effort: 'xhigh' },
    { model: 'claude-sonnet-5-5', effort: 'medium' },
  ])
  expect((spawned as { model?: string }).model).toBe('claude-sonnet-5-5')
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
  expect(text).toContain('full output: /home/dev/.claude/model-router/tee/0.txt')
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
  expect(report.text).toMatch(/saved \| ≈\$0\.\d{3} \(1 routed steps/)
})
