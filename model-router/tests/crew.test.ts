import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, TurnUsage } from 'claude-code'

const CREW = { options: { mode: 'crew' } }
const COMPOSE = { model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], tools: ['Agent', 'SendMessage', 'Bash'], outputStyle: null, traits: [] }

function world(on: On) {
  const sent: { model: string; agentId?: string }[] = []
  const registered: { name: string; model?: string }[] = []
  const spawned: { subagentType: string; model?: string }[] = []
  const agents: AgentInfo[] = []
  let usage: TurnUsage | null = null

  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'router' } }))
  on('command.list', () => ({ value: [] }))
  on('model.complete', () => {
    throw new Error('crew mode routes with the local rules only')
  })
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

  expect(entered.text).toBe('list every TODO in src')
  expect(entered.context?.at(-1)).toContain('The user chose haiku for this task: hand all of it to worker-haiku')
  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
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
  expect(same.text).toBe('add a test for parse()')
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
