import { expect, test } from 'claude-code/testing'

import { CACHE, PROFILE, addLedger, cacheKey, dollars, emptyLedger, learn, priceOf, requestCost, saved, size, switchDelta, turnCost, usd } from '../hooks/cost'

function near(actual: number | undefined, expected: number) {
  expect({ actual, near: Math.abs((actual ?? NaN) - expected) < 1e-9 }).toEqual({ actual, near: true })
}

const OPUS = { model: 'claude-opus-5-5', effort: 'xhigh' }
const SONNET = { model: 'claude-sonnet-5-5', effort: 'medium' }
const HAIKU = { model: 'claude-haiku-5-5', effort: 'low' }
const NOW = 10_000_000

function warmOpus(tokens: number, at = NOW - 1_000) {
  return { [cacheKey(OPUS.model, OPUS.effort)]: { tokens, at } }
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
  const u = { input_tokens: 10_000, output_tokens: 10_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 10_000 }
  // (4 input + 20 output + 0.2 read + 4 * 2 write) per MTok, 10k each
  near(usd('claude-opus-5-5', u), 0.322)
  near(usd('claude-opus-5-5', u, CACHE['5m']), 0.292)
  expect(usd('mystery-model', u)).toBeUndefined()
})

test('Haiku 5.5 bills a prompt over 100K tokens at its long-context rate', async () => {
  const short = { input_tokens: 0, output_tokens: 1_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 }
  const long = { input_tokens: 0, output_tokens: 1_000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 }
  near(usd('claude-haiku-5-5', short), (90_000 * 0.01 + 1_000 * 0.5) / 1e6)
  near(usd('claude-haiku-5-5', long), (150_000 * 0.05 + 1_000 * 2.5) / 1e6)
  near(requestCost('claude-haiku-5-5', 150_000, 0, 0, CACHE['1h']), (150_000 * 0.5 * 2) / 1e6)
})

test('dropping Opus to Haiku for a quick task pays below 100K tokens of context', async () => {
  expect((switchDelta(OPUS, HAIKU, 40_000, warmOpus(40_000), NOW, PROFILE.haiku) ?? 0) < 0).toBe(true)
  expect((switchDelta(OPUS, HAIKU, 90_000, warmOpus(90_000), NOW, PROFILE.haiku) ?? 0) < 0).toBe(true)
})

test('past 100K tokens Haiku costs more than a warm Opus, and the router holds', async () => {
  expect((switchDelta(OPUS, HAIKU, 150_000, warmOpus(150_000), NOW, PROFILE.haiku) ?? 0) > 0).toBe(true)
  expect((switchDelta(OPUS, HAIKU, 400_000, warmOpus(400_000), NOW, PROFILE.haiku) ?? 0) > 0).toBe(true)
})

test('dropping Opus 5.5 to Sonnet 5.5 on a warm session costs more than it saves', async () => {
  for (const context of [40_000, 100_000, 400_000]) {
    expect({ context, holds: (switchDelta(OPUS, SONNET, context, warmOpus(context), NOW, PROFILE.sonnet) ?? 0) > 0 }).toEqual({ context, holds: true })
  }
})

test('once the cache has lapsed, both models pay the write and the cheaper one wins', async () => {
  const lapsed = warmOpus(400_000, NOW - 2 * CACHE['1h'].ttlMs)
  expect((switchDelta(OPUS, SONNET, 400_000, lapsed, NOW, PROFILE.sonnet) ?? 0) < 0).toBe(true)
})

test('the cache belongs to a model and an effort: the same model at another effort is cold', async () => {
  const sameEffort = turnCost(OPUS.model, OPUS.effort, 100_000, warmOpus(100_000), NOW, PROFILE.opus) ?? 0
  const otherEffort = turnCost(OPUS.model, 'high', 100_000, warmOpus(100_000), NOW, PROFILE.opus) ?? 0
  expect(otherEffort > sameEffort).toBe(true)
})

test('a turn pays for what each request adds to the context', async () => {
  const flat = turnCost(OPUS.model, OPUS.effort, 50_000, warmOpus(50_000), NOW, { ...PROFILE.sonnet, added: 0 }) ?? 0
  const growing = turnCost(OPUS.model, OPUS.effort, 50_000, warmOpus(50_000), NOW, { ...PROFILE.sonnet, added: 8_000 }) ?? 0
  // five later requests each write 8k new tokens at 2 x $4 and read the growing prefix
  expect(growing - flat > (5 * 8_000 * 8) / 1e6).toBe(true)
})

test('going back to a model whose cache is still warm costs only what changed since', async () => {
  const cold = switchDelta(HAIKU, OPUS, 120_000, {}, NOW, PROFILE.opus) ?? 0
  const back = switchDelta(HAIKU, OPUS, 120_000, warmOpus(100_000, NOW - 60_000), NOW, PROFILE.opus) ?? 0
  expect(back < cold).toBe(true)
})

test('profiles learn from finished turns, keeping the growth when a turn has one request', async () => {
  const p = learn({ steps: 10, output: 1000, added: 5000 }, PROFILE.sonnet, 20, 2000, 10_000)
  near(p.steps, 12)
  near(p.output, 1200)
  near(p.added, 6000)
  expect(learn({}, PROFILE.haiku, 1, 500).added).toBe(PROFILE.haiku.added)
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
