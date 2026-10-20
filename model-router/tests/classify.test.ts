import { expect, test } from 'claude-code/testing'

import { heuristic, isFollowUp, parseJudge, rubric } from '../hooks/classify'

const CASES: [string, string | undefined][] = [
  ['Translate this error message into German: "File not found"', 'haiku'],
  ['Przetłumacz ten komunikat błędu na angielski', 'haiku'],
  ['Fix the typo "recieve" everywhere in the repo', 'haiku'],
  ['Bump the version in package.json to 2.4.0', 'haiku'],
  ["What's the default port for PostgreSQL?", 'haiku'],
  ['Convert this JSON snippet to YAML', 'haiku'],
  ['Zmień nazwę zmiennej usr na user w src/', 'haiku'],

  ['Add a dark mode toggle to the settings page', 'sonnet'],
  ['Write a SQL query that lists customers with more than 3 orders', 'sonnet'],
  ['Dodaj endpoint do paginacji użytkowników', 'sonnet'],
  ['Refactor the auth module to use dependency injection', 'sonnet'],
  ['Napisz testy jednostkowe dla helperów formatowania dat', 'sonnet'],

  ['Why does this deadlock only under load?', 'opus'],
  ['The test passes locally but is flaky in CI, figure out why', 'opus'],
  ['Dlaczego ta usługa wywala się po restarcie bazy?', 'opus'],
  ['Zaprojektuj architekturę podziału monolitu na usługi', 'opus'],
  ['Audit the session handling for security vulnerabilities', 'opus'],
  ['Plan a migration from REST to GraphQL without downtime', 'opus'],
  ['Zbadaj wyciek pamięci w workerze kolejki', 'opus'],
  ['Memory grows by 50 MB per hour in production, find the memory leak', 'opus'],

  ['Help me with my thing.', undefined],
  ['Can you take a look?', undefined],
]

test('local rules route clear prompts in English and Polish, and leave vague ones to the judge', async () => {
  for (const [prompt, tier] of CASES) {
    expect({ prompt, tier: heuristic(prompt, false)?.tier }).toEqual({ prompt, tier })
  }
})

test('research goes to Fable only when it is enabled', async () => {
  const prompt = 'Prove that this lock-free queue is linearizable'
  expect(heuristic(prompt, false)?.tier).toBe('opus')
  expect(heuristic(prompt, true)?.tier).toBe('fable')
})

test('a rule verdict is confident and says why', async () => {
  const v = heuristic('Why does this deadlock only under load?', false)
  expect(v?.source).toBe('rule')
  expect((v?.confidence ?? 0) >= 0.8).toBe(true)
  expect(v?.why).toContain('unexplained failure')
})

test('short replies are follow-ups', async () => {
  for (const text of ['ok', 'tak', 'dalej', 'do it', 'ok, zrób to teraz', 'go ahead and push it']) {
    expect({ text, follow: isFollowUp(text) }).toEqual({ text, follow: true })
  }
  expect(isFollowUp('Now add pagination to the users endpoint and tests for it')).toBe(false)
})

test('the judge answers one word, Fable folded into Opus when off', async () => {
  expect(parseJudge('SONNET', false)).toBe('sonnet')
  expect(parseJudge('  haiku.\n', false)).toBe('haiku')
  expect(parseJudge('FABLE', false)).toBe('opus')
  expect(parseJudge('FABLE', true)).toBe('fable')
  expect(parseJudge('no idea', false)).toBeUndefined()
  expect(rubric(false)).not.toContain('FABLE')
  expect(rubric(true)).toContain('FABLE')
})
