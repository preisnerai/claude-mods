import { expect, test } from 'claude-code/testing'

import { heuristic, isDissatisfied, isFollowUp, nextTier, parseJudge, parseJudgeVerdict, prevTier, rubric } from '../hooks/classify'

// Prompts whose route is not a judgement call: a regression here is a bug, not a tuning question.
const CRITICAL: [string, string | undefined][] = [
  ['Translate this error message into German: "File not found"', 'haiku'],
  ['Przetłumacz ten komunikat błędu na angielski', 'haiku'],
  ['Fix the typo "recieve" everywhere in the repo', 'haiku'],
  ['Bump the version in package.json to 2.4.0', 'haiku'],
  ["What's the default port for PostgreSQL?", 'haiku'],
  ['Convert this JSON snippet to YAML', 'haiku'],
  ['Zmień nazwę zmiennej usr na user w src/', 'haiku'],
  ['zrób push na github', 'haiku'],
  ['push the changes to GitHub', 'haiku'],
  ['commit and push', 'haiku'],

  ['Add a dark mode toggle to the settings page', 'sonnet'],
  ['utwórz PR i wypchnij na github', 'sonnet'],
  ['git push --force', 'sonnet'],
  ['resolve the merge conflict and push', 'sonnet'],
  ['Write a SQL query that lists customers with more than 3 orders', 'sonnet'],
  ['Dodaj endpoint do paginacji użytkowników', 'sonnet'],
  ['Refactor the auth module to use dependency injection', 'sonnet'],
  ['Napisz testy jednostkowe dla helperów formatowania dat', 'sonnet'],
  ['Translate the error handling module from Python to Go', 'sonnet'],
  ['Review this PR', 'sonnet'],
  ['Debug this function', 'sonnet'],
  ['Zrób research na temat konkurencji', 'sonnet'],
  ['Research the best CRM for a small team', 'sonnet'],
  ['Sprawdź w internecie najnowsze ceny X', 'haiku'],
  ['Zbadaj temat automatyzacji w SPIM', 'sonnet'],

  ['Why does this deadlock only under load?', 'opus'],
  ['The test passes locally but is flaky in CI, figure out why', 'opus'],
  ['Dlaczego ta usługa wywala się po restarcie bazy?', 'opus'],
  ['Zaprojektuj architekturę podziału monolitu na usługi', 'opus'],
  ['Audit the session handling for security vulnerabilities', 'opus'],
  ['Plan a migration from REST to GraphQL without downtime', 'opus'],
  ['Zbadaj wyciek pamięci w workerze kolejki', 'opus'],
  ['Memory grows by 50 MB per hour in production, find the memory leak', 'opus'],

  // A question about a failure is a diagnosis; choosing a design is architecture; "translate" said of code is a port.
  ['What is causing the 500 errors on checkout?', 'opus'],
  ['Co powoduje błąd 500 przy płatności?', 'opus'],
  ["What's wrong with the auth flow? It fails for SSO users", 'opus'],
  ['Which of these two designs scales better?', 'opus'],
  ['Rename the payment service and update every caller across the monorepo', undefined],

  ['Help me with my thing.', undefined],
  ['Can you take a look?', undefined],

  // From a real Polish session log: short confirmations are follow-ups (no tier of their own); a fix with a target,
  // a "why is it wrong", an audit of costs and a plan each read as what they are.
  ['tak rób', undefined],
  ['Tak, etap 5', undefined],
  ['implementuj etap 2', undefined],
  ['napraw ten błąd w register.tsx', 'sonnet'],
  ['fix the failing test in cost.test.ts', 'sonnet'],
  ['dlaczego panel pokazuje zły model?', 'opus'],
  ['zrób audyt kosztów', 'sonnet'],
  ['zaplanuj kolejne kroki', 'opus'],
]

test('local rules route clear prompts in English and Polish, and leave vague ones to the judge', async () => {
  for (const [prompt, tier] of CRITICAL) {
    expect({ prompt, tier: heuristic(prompt, false)?.tier }).toEqual({ prompt, tier })
  }
})

// A labelled corpus of the work this mod actually sees: code, text, spreadsheets, Notion, the browser and email.
// The bar is 85%, so one unusual prompt does not make the suite red; the critical list above is the hard guard.
const CORPUS: [string, string][] = [
  // Haiku: one exact, low-risk step.
  ['Przetłumacz ten akapit na angielski', 'haiku'],
  ['Translate this error message into German: "File not found"', 'haiku'],
  ['Popraw literówki w tym tekście', 'haiku'],
  ['Fix the typo "recieve" everywhere in the repo', 'haiku'],
  ['Zmień nazwę zmiennej usr na user w src/', 'haiku'],
  ['Bump the version in package.json to 2.4.0', 'haiku'],
  ["What's the default port for PostgreSQL?", 'haiku'],
  ['Convert this JSON snippet to YAML', 'haiku'],
  ['Sformatuj ten tekst jako listę punktowaną', 'haiku'],
  ['Streść ten artykuł w 3 punktach', 'haiku'],
  ['Napisz krótkiego maila do klienta z przeprosinami', 'haiku'],
  ['Napisz krótki artykuł o automatyzacji dla początkujących', 'haiku'],
  ['Odpowiedz na tego maila: dziękuję za informacje', 'haiku'],
  ['Posortuj tabelę w Excelu po dacie', 'haiku'],
  ['Usuń duplikaty w tym CSV', 'haiku'],
  ['Dodaj formułę w Excelu, która liczy VAT', 'haiku'],
  ['Kliknij przycisk Zapisz', 'haiku'],
  ['Otwórz stronę example.com', 'haiku'],
  ['Przeczytaj plik README.md', 'haiku'],
  ['Podsumuj ten wątek w dwóch zdaniach', 'haiku'],
  ['zrób push na github', 'haiku'],
  ['push the changes to GitHub', 'haiku'],
  ['commit and push', 'haiku'],

  // Sonnet: a few steps, a known location, or bounded non-code work.
  ['Add a dark mode toggle to the settings page', 'sonnet'],
  ['utwórz PR i wypchnij na github', 'sonnet'],
  ['git push --force', 'sonnet'],
  ['resolve the merge conflict and push', 'sonnet'],
  ['Write a SQL query that lists customers with more than 3 orders', 'sonnet'],
  ['Dodaj endpoint do paginacji użytkowników', 'sonnet'],
  ['Refactor the auth module to use dependency injection', 'sonnet'],
  ['Napisz testy jednostkowe dla helperów formatowania dat', 'sonnet'],
  ['Translate the error handling module from Python to Go', 'sonnet'],
  ['Przygotuj arkusz Excel z podsumowaniem sprzedaży za Q3', 'sonnet'],
  ['Przygotuj arkusz Excel do rozliczenia delegacji', 'sonnet'],
  ['Dodaj kolumnę z VAT w arkuszu', 'haiku'],
  ['Porównaj dwa arkusze i znajdź różnice', 'sonnet'],
  ['Zbuduj tabelę przestawną z tych danych', 'sonnet'],
  ['Zaktualizuj stronę w Notion o nowe wymagania', 'sonnet'],
  ['Dodaj zadanie do Notion i przypisz je do mnie', 'sonnet'],
  ['Otwórz Chrome, zaloguj się i pobierz faktury z portalu', 'sonnet'],
  ['Wypełnij formularz kontaktowy', 'sonnet'],
  ['Napisz sekwencję follow-upów do klientów', 'sonnet'],
  ['Zbuduj workflow w n8n do obsługi leadów', 'sonnet'],
  ['Utwórz agenta, który odpowiada na maile', 'sonnet'],
  ['Napisz skrypt, który wywołuje API i zapisuje wynik do CSV', 'sonnet'],
  ['Review this PR', 'sonnet'],
  ['Debug this function', 'sonnet'],
  ['Zrób research na temat konkurencji', 'sonnet'],
  ['Research the best CRM for a small team', 'sonnet'],
  ['Research the architecture of the new system', 'sonnet'],
  ['Sprawdź w internecie najnowsze ceny X', 'haiku'],
  ['Zbadaj temat automatyzacji w SPIM', 'sonnet'],
  ['Przygotuj raport miesięczny z tych danych', 'sonnet'],
  ['Zrób prezentację z tych danych', 'sonnet'],
  ['Zredaguj ofertę dla klienta na podstawie tych wymagań', 'sonnet'],
  ['Zaktualizuj dokumentację API w Confluence', 'sonnet'],
  ['Napisz post na LinkedIn o automatyzacji', 'haiku'],

  // Opus: unclear causes, high stakes, or a wide change.
  ['Why does this deadlock only under load?', 'opus'],
  ['The test passes locally but is flaky in CI, figure out why', 'opus'],
  ['Dlaczego ta usługa wywala się po restarcie bazy?', 'opus'],
  ['Zaprojektuj architekturę podziału monolitu na usługi', 'opus'],
  ['Audit the session handling for security vulnerabilities', 'opus'],
  ['Plan a migration from REST to GraphQL without downtime', 'opus'],
  ['Zbadaj wyciek pamięci w workerze kolejki', 'opus'],
  ['Memory grows by 50 MB per hour in production, find the memory leak', 'opus'],
  ['What is causing the 500 errors on checkout?', 'opus'],
  ['Co powoduje błąd 500 przy płatności?', 'opus'],
  ["What's wrong with the auth flow? It fails for SSO users", 'opus'],
  ['Which of these two designs scales better?', 'opus'],
  ['Przeanalizuj umowę pod kątem ryzyk', 'opus'],
  ['Przeczytaj umowę i wypisz ryzyka', 'opus'],
  ['Zredaguj umowę na podstawie tego szablonu', 'opus'],
  ['Przeanalizuj proces i zaproponuj automatyzację', 'opus'],
  ['Dlaczego sprzedaż spadła w Q3?', 'opus'],
  ['Deep security review of the auth flow', 'opus'],
  ['Zaprojektuj integrację SPIM z ERP', 'opus'],
  ['Przejrzyj cały kod pod kątem bezpieczeństwa', 'opus'],
  ['Zbadaj, dlaczego automatyzacja w Chrome działa tylko na moim komputerze', 'opus'],

  // Scope words move the same task up or down.
  ['Przetłumacz cały dokument umowy', 'sonnet'],
  ['Streść cały raport', 'sonnet'],
  ['Quick review of this PR', 'sonnet'],

  // A real Polish session.
  ['napraw ten błąd w register.tsx', 'sonnet'],
  ['fix the failing test in cost.test.ts', 'sonnet'],
  ['dlaczego panel pokazuje zły model?', 'opus'],
  ['sprawdź czemu nie widzę stopki', 'opus'],
  ['zrób audyt kosztów', 'sonnet'],
  ['zaplanuj kolejne kroki', 'opus'],
  ['zaplanuj kolejne kroki rozwoju moda', 'opus'],
  ['zrób audyt bezpieczeństwa logowania', 'opus'],
]

test('the labelled corpus matches the route at least 85% of the time', async () => {
  const hits = CORPUS.filter(([prompt, tier]) => heuristic(prompt, false)?.tier === tier).length
  expect(hits / CORPUS.length >= 0.85).toBe(true)
})

test('research is Sonnet or Haiku, never Opus', async () => {
  for (const prompt of [
    'Zrób research na temat konkurencji',
    'Research the best CRM for a small team',
    'Research the architecture of the new system',
    'Zbadaj temat automatyzacji w SPIM',
    'Przeprowadź research rynku',
    'Sprawdź w internecie najnowsze ceny X',
  ]) {
    expect({ prompt, tier: heuristic(prompt, false)?.tier }).not.toEqual({ prompt, tier: 'opus' })
  }
})

test('non-code work is routed by what it is, not by the last code rule', async () => {
  expect(heuristic('Przygotuj arkusz Excel z podsumowaniem sprzedaży za Q3', false)?.tier).toBe('sonnet')
  expect(heuristic('Zaktualizuj stronę w Notion o nowe wymagania', false)?.tier).toBe('sonnet')
  expect(heuristic('Otwórz Chrome, zaloguj się i pobierz faktury z portalu', false)?.tier).toBe('sonnet')
  expect(heuristic('Napisz krótkiego maila do klienta z przeprosinami', false)?.tier).toBe('haiku')
  expect(heuristic('Napisz krótki artykuł o automatyzacji dla początkujących', false)?.tier).toBe('haiku')
})

test('a negation cancels the verb it sits on', async () => {
  expect(heuristic("Don't refactor anything, just translate this text", false)?.tier).toBe('haiku')
  expect(heuristic('Nie refaktoruj, tylko popraw literówki', false)?.tier).toBe('haiku')
  expect(heuristic('Bez refaktoryzacji: dodaj test do parsera', false)?.tier).toBe('sonnet')
  expect(heuristic('Nie tłumacz, tylko popraw formatowanie', false)?.tier).toBe('haiku')
  expect(heuristic('Never refactor this, just fix the typo', false)?.tier).toBe('haiku')
  expect(heuristic('Nigdy nie refaktoryzuj, tylko popraw literówki', false)?.tier).toBe('haiku')
})

test('the size of the prompt is a signal: many files, numbered steps, failed tools', async () => {
  expect(heuristic('Refactor src/a.ts src/b.ts src/c.ts src/d.ts to the new API', false, { failedTools: 0 })?.tier).toBe('opus')
  expect(heuristic('1. read the spec\n2. write the parser\n3. add tests\n4. update the docs', false)?.tier).toBe('sonnet')
  expect(heuristic('fix it', false, { failedTools: 3 })?.tier).toBe('opus')
  expect(heuristic('fix it', false, { failedTools: 0 })).toBeUndefined()
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
  for (const text of ['ok', 'tak', 'dalej', 'do it', 'ok, zrób to teraz', 'go ahead and push it', 'tak rób', 'Tak, etap 5', 'implementuj etap 2']) {
    expect({ text, follow: isFollowUp(text) }).toEqual({ text, follow: true })
  }
  expect(isFollowUp('Now add pagination to the users endpoint and tests for it')).toBe(false)
  // Short, but the rules read them: new tasks, not follow-ups.
  for (const text of ['debug flaky test', 'rename foo bar', 'zrób audyt bezpieczeństwa', 'translate this', 'push na github']) {
    expect({ text, follow: isFollowUp(text) }).toEqual({ text, follow: false })
  }
})

test('dissatisfaction is recognised and is not a follow-up', async () => {
  for (const text of ['znowu źle', 'nadal nie działa', 'popraw to', 'nie o to chodziło', 'still wrong', "that's not what I asked"]) {
    expect({ text, dissatisfied: isDissatisfied(text) }).toEqual({ text, dissatisfied: true })
    expect({ text, follow: isFollowUp(text) }).toEqual({ text, follow: false })
  }
  for (const text of ['popraw literówki', 'popraw to zdanie', 'napraw błąd logowania', 'translate this', 'streść raport']) {
    expect({ text, dissatisfied: isDissatisfied(text) }).toEqual({ text, dissatisfied: false })
  }
})

test('tier helpers stop at the ends and respect enableFable', async () => {
  expect(nextTier('haiku', false)).toBe('sonnet')
  expect(nextTier('sonnet', false)).toBe('opus')
  expect(nextTier('opus', false)).toBeUndefined()
  expect(nextTier('opus', true)).toBe('fable')
  expect(prevTier('opus')).toBe('sonnet')
  expect(prevTier('haiku')).toBeUndefined()
})

test('the judge answers a tier and a confidence, Fable folded into Opus when off', async () => {
  expect(parseJudge('SONNET', false)).toBe('sonnet')
  expect(parseJudge('  haiku.\n', false)).toBe('haiku')
  expect(parseJudge('FABLE', false)).toBe('opus')
  expect(parseJudge('FABLE', true)).toBe('fable')
  expect(parseJudge('no idea', false)).toBeUndefined()
  expect(parseJudgeVerdict('SONNET confidence 0.8', false)).toEqual({ tier: 'sonnet', confidence: 0.8 })
  expect(parseJudgeVerdict('SONNET 0.2', false)).toEqual({ tier: 'sonnet', confidence: 0.2 })
  expect(parseJudgeVerdict('OPUS', false)).toEqual({ tier: 'opus', confidence: 0.7 })
  expect(parseJudgeVerdict('no idea', false)).toBeUndefined()
  expect(rubric(false)).not.toContain('FABLE')
  expect(rubric(true)).toContain('FABLE')
})
