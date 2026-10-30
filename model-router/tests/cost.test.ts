import { expect, test } from 'claude-code/testing'

import { CACHE, PROFILE, addLedger, cacheHitRate, cacheKey, dollars, emptyLedger, learn, mainSaved, priceOf, requestCost, saved, savingsText, size, switchDelta, turnCost, usd, workerSaved } from '../hooks/cost'

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
  expect(priceOf('claude-opus-5-5')?.read).toBe(0.2)
  expect(priceOf('claude-sonnet-5-5')?.read).toBe(0.1)
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

test('dropping Opus 5.5 to Sonnet 5.5 pays on a small warm session and holds past ~50K tokens', async () => {
  // Sonnet 5.5 reads cache at 0.05x input ($0.10/MTok), so a small conversation gains from the switch;
  // the write of a large conversation into Sonnet's cache still costs more than a warm Opus read.
  for (const context of [20_000, 40_000]) {
    expect({ context, saves: (switchDelta(OPUS, SONNET, context, warmOpus(context), NOW, PROFILE.sonnet) ?? 0) < 0 }).toEqual({ context, saves: true })
  }
  for (const context of [60_000, 100_000, 400_000]) {
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

test('cache hit rate counts requests that read any cache', async () => {
  expect(cacheHitRate(emptyLedger())).toBeUndefined()
  expect(cacheHitRate(addLedger(emptyLedger(), { cacheHits: 3, cacheMisses: 1 }))).toBe(0.75)
})

test('a saving reads as saved, a loss as extra against the session model, never as a negative saving', () => {
  expect(savingsText(0.12, 'Opus')).toBe('saved ≈$0.120')
  expect(savingsText(0, 'Opus')).toBe('saved ≈$0.000')
  expect(savingsText(-0.4, 'Haiku')).toBe('extra ≈$0.400 vs your Haiku')
})

test('the ledger splits the workers from the main loop, and an older stored ledger adds up without NaN', () => {
  let l = addLedger(emptyLedger(), { routedSteps: 1, actualUsd: 0.5, baselineUsd: 0.1 })
  l = addLedger(l, { routedSteps: 1, actualUsd: 0.01, baselineUsd: 0.2, workerSteps: 1, workerRoutedSteps: 1, workerActualUsd: 0.01, workerBaselineUsd: 0.2 })
  near(workerSaved(l), 0.19)
  near(mainSaved(l), -0.4)
  near(saved(l), -0.21)

  const { workerSteps: _a, workerRoutedSteps: _b, workerActualUsd: _c, workerBaselineUsd: _d, ...old } = emptyLedger()
  const grown = addLedger(old as never, { workerSteps: 1, workerActualUsd: 0.02 })
  expect(grown.workerSteps).toBe(1)
  near(grown.workerActualUsd, 0.02)
})
