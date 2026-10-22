import { expect, test } from 'claude-code/testing'

import { explainDecision, lastDecision, lastUltracodeAfter } from '../hooks/why'

test('the last decision skips calibration noise', async () => {
  const entries = [
    { at: '2026-10-22T10:00:00.000Z', event: 'judge', reason: 'low-confidence' },
    { at: '2026-10-22T10:01:00.000Z', event: 'route', tier: 'sonnet', source: 'rule', confidence: 0.82, why: 'bounded feature', decision: 'saves ≈$0.004', taken: true, from: 'opus' },
    { at: '2026-10-22T10:02:00.000Z', event: 'compress', compressions: 1 },
  ]
  const entry = lastDecision(entries)
  expect(entry?.event).toBe('route')
  expect(entry?.tier).toBe('sonnet')
})

test('an ultracode hint logged after the route is paired with it', async () => {
  expect(lastUltracodeAfter([{ event: 'route', tier: 'opus' }, { event: 'ultracode', mode: 'suggest' }])?.event).toBe('ultracode')
  expect(lastUltracodeAfter([{ event: 'ultracode' }, { event: 'route', tier: 'opus' }])).toBeUndefined()
})

test('a cache hold is explained as cache math, not a misread', async () => {
  const text = explainDecision({
    event: 'route',
    tier: 'sonnet',
    effort: 'medium',
    effortWanted: 'low',
    source: 'rule',
    confidence: 0.82,
    why: 'bounded feature',
    decision: 'switching costs $0.420 more (cache re-write of 400k tokens)',
    taken: false,
    from: 'opus',
    fromEffort: 'xhigh',
    prompt: 'Add a dark mode toggle to the settings page',
  })
  expect(text).toContain('wanted Sonnet·low')
  expect(text).toContain('stayed on Opus·Extra')
  expect(text).toContain('cache math')
  expect(text).toContain('Prompt: "Add a dark mode toggle')
})

test('effort and Ultracode are named the way Desktop names them', async () => {
  expect(explainDecision({ event: 'route', tier: 'opus', effort: 'xhigh', source: 'rule', confidence: 0.9, why: 'diagnosis', taken: true })).toContain('Opus·Extra')
  expect(explainDecision({ event: 'ultracode', mode: 'suggest', tier: 'opus', effort: 'xhigh', why: 'architecture' })).toContain("add 'ultracode'")
  expect(explainDecision({ event: 'ultracode', mode: 'auto', tier: 'opus', effort: 'xhigh', why: 'hard bug' })).toContain('ran as Ultracode')
})

test('a follow-up, a forced nudge and an escalation each say what happened', async () => {
  expect(explainDecision({ event: 'route', tier: 'sonnet', source: 'follow-up', taken: true })).toContain('continues the work')
  expect(explainDecision({ event: 'route', tier: 'opus', source: 'forced', why: 'forced +1', taken: true })).toContain('forced +1')
  expect(explainDecision({ event: 'route', tier: 'sonnet', source: 'crew', taken: true })).toContain('orchestrator handles it')
  expect(explainDecision({ event: 'escalate', from: 'sonnet', to: 'opus', reason: 'tools keep failing', taken: true })).toContain('tools keep failing')
  expect(explainDecision({ event: 'delegate', tier: 'opus', worker: 'worker-opus' })).toContain('worker-opus')
})

test('a judge that was not sure explains why the model stayed', async () => {
  const text = explainDecision({ event: 'judge', reason: 'low-confidence', tier: 'sonnet', confidence: 0.3 })
  expect(text).toContain('did not decide')
  expect(text).toContain('low-confidence')
  expect(text).toContain('0.30')
})

test('manual switches and engine fallbacks are named', async () => {
  expect(explainDecision({ event: 'manual', to: 'claude-sonnet-5-5' })).toContain('Routing turned off')
  expect(explainDecision({ event: 'fallback', from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' })).toContain('fell back')
  expect(explainDecision(undefined)).toContain('No routing decision')
})
