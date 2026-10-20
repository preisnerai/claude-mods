import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, TurnUsage } from 'claude-code'

const CREW = { options: { mode: 'crew' } }
const COMPOSE = { model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

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
    return { agentId: `agent-${spawned.length}`, model: e.model ?? e.parentModel }
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
  expect(hard.context?.at(-1)).toContain('worker-opus')

  const routine = await submit($, 'Add a dark mode toggle to the settings page')
  expect(routine.context ?? []).toEqual([])
})

test('!haiku delegates instead of switching, and the prefix is stripped', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const entered = await submit($, '!haiku list every TODO in src')
  await step($)

  expect(entered.text).toBe('list every TODO in src')
  expect(entered.context?.at(-1)).toContain('The user asked for haiku: delegate this whole task to worker-haiku')
  expect(w.sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
})

test('a worker runs on its own model, and a second one of the same model is turned to the warm one', CREW, async ($, on) => {
  const w = world(on)
  await start($)

  const first = await spawn($, 'model-router:worker-haiku')
  expect(first.deny).toBeUndefined()
  expect(w.spawned).toEqual([{ subagentType: 'model-router:worker-haiku', model: 'claude-haiku-5-5' }])

  w.agents.push({ id: 'agent-1', teammateId: 'worker-haiku@crew', description: 'task', type: 'model-router:worker-haiku', status: 'idle' } as AgentInfo)
  const second = await spawn($, 'model-router:worker-haiku')
  expect(second.deny).toContain('worker-haiku is already running as worker-haiku@crew: send it this task with SendMessage')

  const other = await spawn($, 'model-router:worker-opus')
  expect(other.deny).toBeUndefined()
})

test("workers' steps count as savings against the session's model", CREW, async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'Add a dark mode toggle to the settings page')

  w.setUsage({ input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, model: '' })
  const { agentId } = await spawn($, 'model-router:worker-haiku')
  await step($, agentId, 'claude-haiku-5-5')

  const report = await $.command.run({ command: 'router', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(report.text).toMatch(/1 routed steps: \$0\.00\d+ instead of \$0\.05/)
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
