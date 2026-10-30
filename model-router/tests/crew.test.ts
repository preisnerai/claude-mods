import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, TurnUsage } from 'claude-code'

// The prompt row carries the mod's tag after the typed words; tests of the prompt's own words drop it.
const bare = (text: string | undefined) => (text ?? '').replace(/\n\n\*router: [^*]+\*$/, '')

const CREW = { options: { mode: 'crew' } }
const COMPOSE = { model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], tools: ['Agent', 'SendMessage', 'Bash'], outputStyle: null, traits: [] }

function world(on: On, model = 'claude-opus-5-5', judge?: string) {
  const sent: { model: string; agentId?: string }[] = []
  const registered: { name: string; model?: string }[] = []
  const spawned: { subagentType: string; model?: string }[] = []
  const agents: AgentInfo[] = []
  let usage: TurnUsage | null = null

  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.model', () => ({ value: model }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'router' } }))
  on('command.list', () => ({ value: [] }))
  on('model.complete', () => {
    if (judge === undefined) {
      throw new Error('crew mode routes with the local rules only')
    }
    return { value: { isAnswered: true, text: judge, usage: { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('session.send', () => ({ isDelivered: true }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.register', ($, e) => {
    registered.push({ name: e.name, model: e.model })
    return { value: { agent: `model-router:${e.name}` } }
  })
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, e) => {
    spawned.push({ subagentType: e.subagentType, model: e.model })
    return { agentId: `agent-${spawned.length}`, model: e.model ?? e.parentModel ?? 'claude-sonnet-5-5' }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    sent.push({ model: e.model, ...(e.agentId ? { agentId: e.agentId } : {}) })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage === null ? null : { ...usage, model: e.model } }
  })

  return {
    sent,
    registered,
    spawned,
    agents,
    setUsage: (u: TurnUsage) => (usage = u),
  }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, agentId?: string, model = 'claude-opus-5-5') {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort: 'xhigh', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
    // drained
  }
}

function spawn($: Engine, subagentType: string) {
  const input = { prompt: 'task', description: 'task', subagentType, name: subagentType.split(':')[1] ?? subagentType }
  return $.agent.spawn(input as never as Parameters<Engine['agent']['spawn']>[0])
}

test('crew mode registers one worker per model', CREW, async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered).toEqual([
    { name: 'worker-haiku', model: 'claude-haiku-5-5' },
    { name: 'worker-sonnet', model: 'claude-sonnet-5-5' },
    { name: 'worker-opus', model: 'claude-opus-5-5' },
  ])
})

test('the main session stays on the orchestrator whatever the prompt', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  for (const prompt of ['Translate this error message into German please', 'Why does this deadlock only under load?', 'ok']) {
    await submit($, prompt)
    await step($)
  }
  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
})

test('a prompt for another model carries a hint to hand it to that worker', CREW, async ($, on) => {
  world(on)
  await start($)

  const hard = await submit($, 'Why does this deadlock only under load?')
  expect(hard.context?.at(-1)).toContain('opus-level task: if it takes three or more tool calls, hand it to worker-opus')

  const routine = await submit($, 'Add a dark mode toggle to the settings page')
  expect(routine.context ?? []).toEqual([])

  // Below the orchestrator a hand-off and a report cost more than doing it: no hint.
  const quick = await submit($, 'Translate this error message into German please')
  expect(quick.context ?? []).toEqual([])
})

test('!haiku delegates instead of switching, and the prefix is stripped', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const entered = await submit($, '!haiku list every TODO in src')
  await step($)

  expect(bare(entered.text)).toBe('list every TODO in src')
  expect(entered.context?.at(-1)).toContain('The user chose haiku for this task: hand all of it to worker-haiku')
  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
})

test('!+ on a fresh crew session lifts the orchestrator, not the session /model', CREW, async ($, on) => {
  world(on)
  await start($)

  const entered = await submit($, '!+ refactor the auth module')

  expect(bare(entered.text)).toBe('refactor the auth module')
  expect(entered.context?.at(-1)).toContain('hand all of it to worker-opus')
})

test('a worker runs on its own model, and a second one of the same model is turned to the warm one', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const first = await spawn($, 'model-router:worker-haiku')
  expect(first.deny).toBeUndefined()
  expect(w.spawned).toEqual([{ subagentType: 'model-router:worker-haiku', model: 'claude-haiku-5-5' }])

  w.agents.push({ id: 'agent-1', name: 'worker-haiku', teammateId: 'worker-haiku@crew', description: 'task', type: 'model-router:worker-haiku', status: 'idle' } as AgentInfo)
  const second = await spawn($, 'model-router:worker-haiku')
  expect(second.deny).toContain('worker-haiku is already started: send this task with SendMessage to "worker-haiku"')

  const other = await spawn($, 'model-router:worker-opus')
  expect(other.deny).toBeUndefined()
})

test('two Agent calls for the same worker in one response start one worker', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const [a, b] = await Promise.all([spawn($, 'model-router:worker-haiku'), spawn($, 'model-router:worker-haiku')])

  expect(w.spawned.length).toBe(1)
  expect([a.deny, b.deny].filter(d => d !== undefined).length).toBe(1)
})

test("workers' steps count as savings against the session's model", CREW, async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'Add a dark mode toggle to the settings page')

  w.setUsage({ input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, model: '' })
  const { agentId } = await spawn($, 'model-router:worker-haiku')
  await step($, agentId, 'claude-haiku-5-5')

  const report = await $.command.run({ command: 'router', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(report.text).toMatch(/\$0\.00\d+ spent instead of \$0\.05\d+, 1 requests routed/)
})

test('the orchestrator reads the crew section; workers do not', CREW, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await start($)

  const main = await $.prompt.compose(COMPOSE)
  expect(main.sections.map(s => s.id)).toEqual(['intro', 'model-router:style', 'model-router:crew'])
  expect(main.sections.at(-1)?.text).toContain('SendMessage')

  const teammate = await $.prompt.compose({ ...COMPOSE, traits: ['teammate'] })
  expect(teammate.sections.map(s => s.id)).toEqual(['intro', 'model-router:style'])
})

test('!sonnet on a Sonnet orchestrator adds no hand-off; !fable goes to the strongest worker and says so', CREW, async ($, on) => {
  world(on)
  await start($)

  const same = await submit($, '!sonnet add a test for parse()')
  expect(bare(same.text)).toBe('add a test for parse()')
  expect(same.context ?? []).toEqual([])

  const fable = await submit($, '!fable prove that this lock is linearizable')
  expect(fable.context?.at(-1)).toContain('hand all of it to worker-opus')
})

test('a finished worker is resumed by its id; a short spelling meets the same worker', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  w.agents.push({ id: 'agent-7', name: 'worker-opus', description: 'task', type: 'model-router:worker-opus', status: 'completed' } as AgentInfo)
  const again = await spawn($, 'worker-opus')
  expect(again.deny).toContain('SendMessage to "agent-7" (it resumes with what it learned)')
})

test('a worker that grew far past a fresh one, or went cold, gives way to a fresh worker', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const { agentId } = await spawn($, 'model-router:worker-haiku')
  w.setUsage({ input_tokens: 0, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 12_000, model: '' })
  await step($, agentId, 'claude-haiku-5-5')
  w.setUsage({ input_tokens: 0, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 180_000, model: '' })
  await step($, agentId, 'claude-haiku-5-5')
  w.agents.push({ id: agentId ?? '', name: 'worker-haiku', description: 'task', type: 'model-router:worker-haiku', status: 'idle' } as AgentInfo)

  const next = await spawn($, 'model-router:worker-haiku')
  expect(next.deny).toBeUndefined()
  expect(w.spawned.length).toBe(2)
})

test('a worker cannot start workers, and a renamed spawn gets past a worker that stopped answering', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const { agentId } = await spawn($, 'model-router:worker-sonnet')
  const nested = await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'model-router:worker-opus', parentAgentId: agentId } as never)
  expect(nested.deny).toContain('A worker does its task itself')

  w.agents.push({ id: agentId ?? '', name: 'worker-sonnet', description: 'task', type: 'model-router:worker-sonnet', status: 'idle' } as AgentInfo)
  const renamed = await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'model-router:worker-sonnet', name: 'worker-sonnet-2' } as never)
  expect(renamed.deny).toBeUndefined()
})

test('/router off turns crew off: no crew section, no spawn checks', CREW, async ($, on) => {
  const w = world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await start($)

  await $.command.run({ command: 'router', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toEqual(['intro', 'model-router:style'])
  w.agents.push({ id: 'agent-1', name: 'worker-haiku', description: 'task', type: 'model-router:worker-haiku', status: 'idle' } as AgentInfo)
  expect((await spawn($, 'model-router:worker-haiku')).deny).toBeUndefined()
})

test('a teammate gets the terse rules even when the person chose the ADHD shape', { options: { mode: 'crew', style: 'adhd' } }, async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await start($)

  expect((await $.prompt.compose(COMPOSE)).sections.find(s => s.id === 'model-router:style')?.text).toContain('ADHD-friendly')
  expect((await $.prompt.compose({ ...COMPOSE, traits: ['teammate'] })).sections.find(s => s.id === 'model-router:style')?.text).toContain('Output economy')
})

const ROUTER = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

async function complete($: Engine) {
  return $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never)
}

async function decisions($: Engine): Promise<Record<string, unknown>[]> {
  const shown = await $.command.run({ command: 'router', args: 'log', ...ROUTER })
  return shown.text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
}

test('on a Haiku session the crew note, pane and log say Sonnet overrides it', CREW, async ($, on) => {
  const w = world(on, 'claude-haiku-5-5')
  await start($)

  await submit($, 'tak rób')
  w.setUsage({ input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, model: '' })
  await step($, undefined, 'claude-haiku-5-5')
  const done = await complete($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
  expect(done.text).toContain('model-router: Sonnet·medium (overrides your Haiku) · crew · follow-up')

  const log = await decisions($)
  const route = log.find(e => e.event === 'route')
  expect(route?.from).toBe('haiku')
  expect(route?.session).toBe('claude-haiku-5-5')
  expect(route?.sent).toBe('claude-sonnet-5-5')
  const turn = log.find(e => e.event === 'turn')
  expect(turn).toMatchObject({ session: 'claude-haiku-5-5', sent: 'claude-sonnet-5-5', actual: 'claude-sonnet-5-5', from: 'haiku' })

  const ui = await $.ui.mount({ plugin: 'model-router', component: 'Pane', requestId: 'model-router', props: { title: 'Model router' } as never, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Sonnet·medium \(overrides your Haiku\) · crew$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a crew that costs more than the session model says extra, never a negative saving', CREW, async ($, on) => {
  const w = world(on, 'claude-haiku-5-5')
  await start($)

  await submit($, 'Add a dark mode toggle to the settings page')
  w.setUsage({ input_tokens: 100, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000, model: '' })
  await step($, undefined, 'claude-haiku-5-5')
  const done = await complete($)

  expect(done.text).toMatch(/extra ≈\$0\.\d+ vs your Haiku/)
  expect(done.text).not.toContain('saved ≈-')
  const report = await $.command.run({ command: 'router', args: '', ...ROUTER })
  expect(report.text).toContain('Sonnet·medium (overrides your Haiku) · crew')
  expect(report.text).toMatch(/\| main loop \| extra ≈\$0\.\d+ vs your Haiku: .*1 requests on another model/)
  expect(report.text).toContain('| workers | — |')
  expect(report.text).not.toContain('≈$-')
})

test('orchestrator: session follows the session model and sends its requests untouched', { options: { mode: 'crew', orchestrator: 'session' } }, async ($, on) => {
  const w = world(on, 'claude-haiku-5-5')
  await start($)

  const hard = await submit($, 'Why does this deadlock only under load?')
  expect(hard.context?.at(-1)).toContain('hand it to worker-opus')
  await step($, undefined, 'claude-haiku-5-5')
  const done = await complete($)

  expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5'])
  // The effort is the one the request went out with: the session's own, here xhigh (Extra).
  expect(done.text).toContain('model-router: Haiku·Extra · crew → worker-opus')
  expect(done.text).not.toContain('overrides')

  await submit($, 'Add a dark mode toggle to the settings page')
  const second = await complete($)
  expect(second.text).toContain('· crew → worker-sonnet')
})

test('the main loop and the workers are billed apart, and a worker on the session model is not routed', CREW, async ($, on) => {
  const w = world(on, 'claude-sonnet-5-5')
  await start($)
  await submit($, 'Add a dark mode toggle to the settings page')

  w.setUsage({ input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, model: '' })
  const { agentId } = await spawn($, 'model-router:worker-sonnet')
  await step($, agentId, 'claude-sonnet-5-5')
  const haiku = await spawn($, 'model-router:worker-haiku')
  await step($, haiku.agentId, 'claude-haiku-5-5')

  const report = await $.command.run({ command: 'router', args: '', ...ROUTER })
  expect(report.text).toMatch(/\| workers \| saved ≈\$0\.\d+: \$0\.\d+ instead of \$0\.\d+, 2 requests/)
  expect(report.text).toMatch(/1 requests routed/)
})

test('a short follow-up goes on with the worker the last task went to', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const hard = await submit($, 'Why does this deadlock only under load?')
  expect(hard.context?.at(-1)).toContain('hand it to worker-opus')
  w.agents.push({ id: 'agent-3', name: 'worker-opus', description: 'task', type: 'model-router:worker-opus', status: 'idle' } as AgentInfo)

  for (const text of ['tak rób', 'Tak, etap 5', 'implementuj etap 2']) {
    const follow = await submit($, text)
    expect({ text, hint: follow.context?.at(-1) }).toEqual({ text, hint: expect.stringContaining('Follow-up to the opus-level task handed to worker-opus') })
    expect(follow.context?.at(-1)).toContain('SendMessage to "worker-opus"')
  }
  expect(bare((await submit($, 'tak rób')).text)).toBe('tak rób')

  // A new task the orchestrator keeps ends the chain: the next "tak" is the orchestrator's.
  await submit($, 'Add a dark mode toggle to the settings page')
  const after = await submit($, 'tak')
  expect(after.context ?? []).toEqual([])
  const log = await decisions($)
  expect(log.at(-1)).toMatchObject({ event: 'route', why: 'follow-up', decision: 'stays with the orchestrator' })
})

test('a follow-up with no hand-off before it stays with the orchestrator', CREW, async ($, on) => {
  world(on)
  await start($)
  const follow = await submit($, 'tak rób')
  expect(follow.context ?? []).toEqual([])
})

test('crewJudge asks the judge what the rules cannot call; off, the rules alone decide', { options: { mode: 'crew', crewJudge: true } }, async ($, on) => {
  world(on, 'claude-opus-5-5', 'OPUS confidence 0.9')
  await start($)
  const vague = await submit($, 'Help me with my thing in the app.')
  expect(vague.context?.at(-1)).toContain('hand it to worker-opus')
  const log = await decisions($)
  expect(log.find(e => e.event === 'delegate')).toMatchObject({ source: 'judge', worker: 'worker-opus' })
})

test('without crewJudge a vague prompt makes no judge call', CREW, async ($, on) => {
  world(on)
  await start($)
  // world() throws on any model call: this passing means the judge was not asked.
  const vague = await submit($, 'Help me with my thing in the app.')
  expect(vague.context ?? []).toEqual([])
})

test('the log says whether the orchestrator took a hand-off: a spawn, a SendMessage, or the turn ending first', CREW, async ($, on) => {
  world(on)
  await start($)

  await submit($, 'Why does this deadlock only under load?')
  await spawn($, 'model-router:worker-opus')
  await complete($)

  await submit($, 'Investigate the root cause of the flaky checkout test')
  await $.session.send({ to: 'worker-opus', text: 'next task' } as never)
  await complete($)

  await submit($, 'Why does the cache crash under load?')
  await complete($)

  const handoffs = (await decisions($)).filter(e => e.event === 'handoff')
  expect(handoffs.map(e => [e.worker, e.followed, e.via])).toEqual([
    ['worker-opus', true, 'spawn'],
    ['worker-opus', true, 'SendMessage'],
    ['worker-opus', false, 'turn ended'],
  ])
})

test('a crew prompt row is tagged with the orchestrator it ran on and the worker its hint named', CREW, async ($, on) => {
  const w = world(on, 'claude-haiku-5-5')
  on('ui.render', ($, e) => ({ type: 'Text', children: [String((e.props as { text?: unknown }).text ?? '')] }) as never)
  await start($)

  const prompt = 'Why does this deadlock only under load?'
  const sent = await submit($, prompt)
  expect(sent.text).toBe(prompt)
  w.setUsage({ input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, model: '' })
  await step($, undefined, 'claude-haiku-5-5')
  await complete($)

  const ui = await $.ui.mount({ plugin: 'model-router', component: 'UserMessage', props: { text: prompt, origin: { kind: 'composer' }, isExpanded: true } as never, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'router: Sonnet·medium (overrides your Haiku) · crew → worker-opus' })) !== undefined).toBe(true)
  await ui.unmount()
})
