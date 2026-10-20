import { expect, test } from 'claude-code/testing'

import { CACHE, PROFILE, addLedger, dollars, emptyLedger, learn, priceOf, saved, size, switchDelta, usd } from '../hooks/cost'

function near(actual: number | undefined, expected: number) {
  expect({ actual, near: Math.abs((actual ?? NaN) - expected) < 1e-9 }).toEqual({ actual, near: true })
}

test('prices resolve from full ids, suffixed ids, provider prefixes and aliases', async () => {
  expect(priceOf('claude-opus-5-5')?.input).toBe(4)
  expect(priceOf('claude-opus-5-5[1m]')?.input).toBe(4)
  expect(priceOf('anthropic.claude-opus-5-5')?.input).toBe(4)
  expect(priceOf('claude-opus-5')?.input).toBe(5)
  expect(priceOf('haiku')?.input).toBe(0.1)
  expect(priceOf('gpt-9')).toBeUndefined()
})

test('a request costs its four token kinds at their prices', async () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
  // 4 input + 20 output + 0.2 read + 4 * 2 write (1-hour entries)
  near(usd('claude-opus-5-5', u), 32.2)
  near(usd('claude-opus-5-5', u, CACHE['5m']), 29.2)
  expect(usd('mystery-model', u)).toBeUndefined()
})

test('dropping to Haiku pays for its cache write even on a long session', async () => {
  const now = 1_000_000
  const warm = { 'claude-opus-5-5': { tokens: 100_000, at: now - 1_000 } }
  const delta = switchDelta('claude-opus-5-5', 'claude-haiku-5-5', 100_000, warm, now, PROFILE.haiku)
  expect((delta ?? 0) < 0).toBe(true)
})

test('dropping Opus 5.5 to Sonnet 5.5 on a long cached session costs more than it saves', async () => {
  // Both read cache at $0.20/MTok: Sonnet saves only on output, and writing 400k tokens into its cache costs $1.
  const now = 1_000_000
  const warm = { 'claude-opus-5-5': { tokens: 400_000, at: now - 1_000 } }
  const delta = switchDelta('claude-opus-5-5', 'claude-sonnet-5-5', 400_000, warm, now, PROFILE.sonnet)
  expect((delta ?? 0) > 0).toBe(true)
})

test('a cold cache makes the switch free: both models pay the write', async () => {
  const now = 2 * CACHE['1h'].ttlMs
  const warm = { 'claude-opus-5-5': { tokens: 400_000, at: 0 } }
  const delta = switchDelta('claude-opus-5-5', 'claude-sonnet-5-5', 400_000, warm, now, PROFILE.sonnet)
  expect((delta ?? 0) < 0).toBe(true)
})

test('going back to a model whose cache is still warm costs only what changed since', async () => {
  const now = 1_000_000
  const cold = switchDelta('claude-haiku-5-5', 'claude-opus-5-5', 120_000, {}, now, PROFILE.opus) ?? 0
  const back = switchDelta('claude-haiku-5-5', 'claude-opus-5-5', 120_000, { 'claude-opus-5-5': { tokens: 100_000, at: now - 60_000 } }, now, PROFILE.opus) ?? 0
  expect(back < cold).toBe(true)
})

test('profiles learn from finished turns', async () => {
  const p = learn({ steps: 10, output: 1000 }, 20, 2000)
  near(p.steps, 12)
  near(p.output, 1200)
})

test('the ledger adds up, turns per tier included', async () => {
  let l = addLedger(emptyLedger(), { turns: { sonnet: 1 }, routedSteps: 2, actualUsd: 0.1, baselineUsd: 0.5, judgeUsd: 0.01 })
  l = addLedger(l, { turns: { sonnet: 1, haiku: 1 } })
  expect(l.turns).toEqual({ haiku: 1, sonnet: 2, opus: 0, fable: 0 })
  near(saved(l), 0.39)
})

test('money and counts read well at every size', async () => {
  expect([dollars(0), dollars(0.00005), dollars(0.149), dollars(4.2), dollars(42.4), dollars(-0.12)]).toEqual(['$0.000', '$0.0001', '$0.149', '$4.20', '$42', '-$0.120'])
  expect([size(940), size(9_616), size(182_400)]).toEqual(['940', '9.6k', '182k'])
})
