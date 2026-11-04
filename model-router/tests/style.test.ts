import { expect, test } from 'claude-code/testing'

import { STYLE, isStyle } from '../hooks/style'

test('the styles are short sections, so the cached system prompt barely grows', () => {
  expect(STYLE.off).toBeUndefined()
  // About four characters a token: the terse rules stay under ~450 tokens, the ADHD shape under ~700.
  expect((STYLE.terse ?? '').length < 1_800).toBe(true)
  expect((STYLE.adhd ?? '').length < 2_800).toBe(true)
  expect([isStyle('terse'), isStyle('adhd'), isStyle('off'), isStyle('loud')]).toEqual([true, true, true, false])
})

test('a list cap never limits what is searched, and options stay an answer', () => {
  for (const text of [STYLE.terse ?? '', STYLE.adhd ?? '']) {
    expect(/never (for )?what you search/.test(text)).toBe(true)
    expect(text).toContain('2 to 4')
    expect(text).toContain('destructive actions')
  }
})

test('the terse rules cut announcing openers, recaps, asides and empty hedges before sending', () => {
  expect(STYLE.terse).toContain('Before sending, cut a first sentence that only announces what follows')
  expect(STYLE.terse).toContain('keep a hedge that marks real uncertainty')
})

test('the ADHD shape holds across topics, keeps the plan in a task tool and checks the first and last line', () => {
  expect(STYLE.adhd).toContain('hold for the whole session, whatever the topic')
  expect(STYLE.adhd).toContain('With a task or plan tool, keep the steps there')
  expect(STYLE.adhd).toContain('the first line says what to do next, the last says what just happened')
})
