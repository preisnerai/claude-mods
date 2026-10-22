import { expect, test } from 'claude-code/testing'

import { clampEffort, effortFor, isHardest, learnedLine, nudge, shiftOf, shiftTier } from '../hooks/adapt'

const DAY = 24 * 60 * 60_000

test('max is never an effort the router sends', async () => {
  expect(clampEffort('max', 'high')).toBe('xhigh')
  expect(clampEffort('bogus', 'high')).toBe('high')
  expect(effortFor({ tier: 'fable', confidence: 0.95, source: 'rule', why: 'proof' }, 'xhigh', 2)).toBe('xhigh')
})

test('effort moves within the tier: deep up, trivial down', async () => {
  expect(effortFor({ tier: 'opus', confidence: 0.9, source: 'rule', why: 'diagnosis' }, 'high')).toBe('xhigh')
  expect(effortFor({ tier: 'opus', confidence: 0.7, source: 'judge', why: 'judge' }, 'high')).toBe('high')
  expect(effortFor({ tier: 'sonnet', confidence: 0.9, source: 'rule', why: 'translation' }, 'medium')).toBe('low')
  expect(effortFor({ tier: 'haiku', confidence: 0.9, source: 'rule', why: 'rename' }, 'low', -2)).toBe('low')
  expect(effortFor({ tier: 'haiku', confidence: 0.9, source: 'rule', why: 'simple research, research' }, 'low')).toBe('low')
})

test('only confident hardest tasks are ultracode candidates', async () => {
  expect(isHardest({ tier: 'opus', confidence: 0.95, source: 'rule', why: 'architecture' })).toBe(true)
  expect(isHardest({ tier: 'opus', confidence: 0.7, source: 'judge', why: 'judge' })).toBe(false)
  expect(isHardest({ tier: 'sonnet', confidence: 0.95, source: 'rule', why: 'architecture' })).toBe(false)
})

test('bias is bounded, fades, and is shown', async () => {
  let b = {}
  for (let i = 0; i < 5; i++) b = nudge(b, 'diagnosis', 'effort', 1, 0)
  expect(shiftOf(b, 'diagnosis', 0)).toEqual({ tier: 0, effort: 2 })
  expect(learnedLine(b, 0)).toBe('diagnosis +2 effort')
  expect(shiftOf(b, 'diagnosis', 28 * DAY).effort).toBe(1)
  expect(shiftOf(b, 'diagnosis', 90 * DAY).effort).toBe(0)
  expect(learnedLine({}, 0)).toBeUndefined()
  expect(shiftTier('opus', 1, false)).toBe('opus')
  expect(shiftTier('haiku', -1, false)).toBe('haiku')
})
