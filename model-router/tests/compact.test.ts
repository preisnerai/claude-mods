import { expect, test } from 'claude-code/testing'

import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, SessionMessage } from 'claude-code'

import { chunk, estimateTokens, keepFrom, renderTranscript, summarize } from '../hooks/compact'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role: 'assistant', text, toolUses })
const result = (id: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text: 'a.txt', isError: false }],
})

const TRANSCRIPT = [prompt('fix the bug'), reply('one'), result('t-one'), reply('done'), prompt('now test it'), reply('ok')]

test('the transcript renders prompts, replies and tool calls with their results', async () => {
  const text = renderTranscript([
    prompt('fix the bug in src/a.ts'),
    reply('', [{ tool: 'Bash', input: { command: 'npm test' }, text: '1 failed' }]),
    reply('fixed'),
  ])
  expect(text).toContain('## User\nfix the bug in src/a.ts')
  expect(text).toContain('→ Bash {"command":"npm test"}')
  expect(text).toContain('⇒ 1 failed')
  expect(text).toContain('## Assistant\nfixed')
})

test('tool text is clipped with a marker; prompts pass through whole', async () => {
  const text = renderTranscript([prompt('q'.repeat(5_000)), reply('', [{ tool: 'Bash', input: {}, text: 'y'.repeat(4_001) }])])
  expect(text).toContain('q'.repeat(5_000))
  expect(text).toContain('chars cut]')
})

test('chunk splits at message boundaries, stays under the cap and loses nothing', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `## User\nmessage ${i}`).join('\n\n')
  const pieces = chunk(text, 200)
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces.join('')).toBe(text)
  for (const piece of pieces) {
    expect(piece.length).toBeLessThanOrEqual(200)
  }
})

test('keepFrom starts the kept tail at a typed prompt, never mid tool loop', async () => {
  expect(keepFrom(TRANSCRIPT, 4)).toBe(4)
  expect(keepFrom(TRANSCRIPT, 2)).toBe(4)
  expect(keepFrom(TRANSCRIPT, 99)).toBe(0)
  expect(keepFrom([reply('no prompt here')], 4)).toBe(1)
})

test('the token estimate is about four characters a token', async () => {
  const messages = [prompt('a'.repeat(4_000))]
  expect(estimateTokens(messages)).toBeGreaterThan(900)
  expect(estimateTokens(messages)).toBeLessThan(1_100)
})

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const fakeModel = (asked: ModelCompleteRequest[], answer: () => ModelCompleteResult) =>
  ({ model: { complete: async (req: ModelCompleteRequest) => (asked.push(req), answer()) } }) as unknown as EngineInterface

test('summarize asks for the older part and keeps the tail verbatim', async () => {
  const asked: ModelCompleteRequest[] = []
  const $ = fakeModel(asked, () => ({ isAnswered: true, text: 'SUMMARY', usage: USAGE }))
  const done = await summarize($, 'haiku', TRANSCRIPT, 4, 'the plan')

  expect(asked).toHaveLength(1)
  expect(asked[0]?.prompt).toContain('fix the bug')
  expect(asked[0]?.prompt).not.toContain('now test it')
  expect(String(asked[0]?.system)).toContain('the plan')
  expect(done.messages?.map(m => m.text)).toEqual([expect.stringContaining('SUMMARY'), 'now test it', 'ok'])
  expect(done.messages?.[0]?.role).toBe('user')
})

test('summarize carries the summary across chunks of a long transcript', async () => {
  const asked: ModelCompleteRequest[] = []
  let n = 0
  const $ = fakeModel(asked, () => ({ isAnswered: true, text: `S${++n}`, usage: USAGE }))
  const long = [...Array.from({ length: 300 }, (_, i) => [prompt(`p${i} ${'x'.repeat(2_000)}`), reply(`r${i}`)]).flat(), prompt('last')]
  const done = await summarize($, 'haiku', long, 1)

  expect(asked.length).toBeGreaterThan(1)
  expect(String(asked[1]?.prompt)).toContain('S1')
  expect(done.messages?.[0]?.text).toContain(`S${asked.length}`)
  expect(done.messages?.at(-1)?.text).toBe('last')
})

test('summarize skips when the model fails, never returning a broken transcript', async () => {
  const $ = fakeModel([], () => ({ isAnswered: false, reason: 'api-error', usage: USAGE }))
  const done = await summarize($, 'haiku', TRANSCRIPT, 4)
  expect(done.skip).toContain('api-error')
  expect(done.messages).toBeUndefined()
})

test('summarize skips when nothing older than the kept tail exists', async () => {
  const asked: ModelCompleteRequest[] = []
  const $ = fakeModel(asked, () => ({ isAnswered: true, text: 'SUMMARY', usage: USAGE }))
  const done = await summarize($, 'haiku', TRANSCRIPT, 99)
  expect(asked).toHaveLength(0)
  expect(done.skip).toContain('nothing older')
})
