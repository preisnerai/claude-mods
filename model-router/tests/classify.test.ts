import { expect, test } from 'claude-code/testing'

import { clean, heuristic, isDissatisfied, isEditTool, isFollowUp, isJudgment, nextTier, parseJudge, parseJudgeVerdict, prevTier, rubric } from '../hooks/classify'

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

  // Graphic work, file and folder operations and choices, from the same log: before, the rules had no word for them.
  ['zrób mi 30 nowych szablonów ulotek w pdf', 'sonnet'],
  ['zrób mi 30 nowych szablonów, pdf umieść w podfolderze pdf', 'sonnet'],
  ['Zaprojektuj plakat na festyn', 'sonnet'],
  ['Design a poster for the conference', 'sonnet'],
  ['Make a flyer for the open day', 'sonnet'],
  ['zrób mi foldery na każdy miesiąc', 'haiku'],
  ['Dobra to zrób mi foldery z projektami które mam', 'haiku'],
  ['przenieś pliki do folderu archiwum', 'haiku'],
  ['Create a folder for each month', 'haiku'],
  ['usuń wszystkie pliki tymczasowe z folderu', 'sonnet'],
  ['delete all temp files in the folder', 'sonnet'],
  ['lepiej wykorzystać everos czy notion?', 'sonnet'],
  ['co lepsze: notion czy obsidian?', 'sonnet'],
  ['which is better, React or Vue?', 'sonnet'],
  // "All" in one file is more of the same work; over a project or a repo it is wider work.
  ['Dodaj testy jednostkowe dla wszystkich funkcji w utils.ts', 'sonnet'],
  ['add tests for all endpoints in api.ts', 'sonnet'],
  ['przepisz cały projekt na TypeScript', 'opus'],
  ['refactor every module in the repo', 'opus'],
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

test('right after a turn that did work, a short miss without "znowu" is dissatisfaction; before any work it is a bug report', async () => {
  const worked = { lastTurn: { steps: 4, edited: false } }
  const editedOnce = { lastTurn: { steps: 1, edited: true } }
  const idle = { lastTurn: { steps: 1, edited: false } }
  const misses = [
    'nie działa',
    'źle to się wyświetla',
    'nie działa kombinuj by to zrobić',
    'te oferty nie otwierają mi się poprawnie',
    'Mi chodziło o 30 RÓŻNIĄCYCH się od siebie szablonów, a ty zrobiłeś jeden',
    'miało być na niebiesko',
    'czemu pdf nie są w pdf',
    "it doesn't work",
    "that's not it",
    'wrong file',
    'nie ja to wrzucam na vps co ty kurwa',
    'wtf',
    'cholera, nie o to',
  ]
  for (const text of misses) {
    expect({ text, worked: isDissatisfied(text, worked), edited: isDissatisfied(text, editedOnce) }).toEqual({ text, worked: true, edited: true })
    expect({ text, follow: isFollowUp(text, false, worked) }).toEqual({ text, follow: false })
  }
  // No context, or a turn that only answered: "nie działa X" reports a bug, it is not a verdict on the last answer.
  for (const text of ['nie działa', 'nie działa logowanie po restarcie', "it doesn't work", 'źle to się wyświetla', 'wrong file']) {
    expect({ text, none: isDissatisfied(text), idle: isDissatisfied(text, idle) }).toEqual({ text, none: false, idle: false })
  }
  expect(isFollowUp('nie działa')).toBe(true)
  // A long message is a new brief, whatever it starts with; a new task with no failure in it is no miss.
  expect(isDissatisfied(`nie działa, ${'opiszę dokładnie co trzeba zrobić w tym module '.repeat(4)}`, worked)).toBe(false)
  for (const text of ['Add a dark mode toggle to the settings page', 'tak rób', 'ok', 'why do you want to use redis here?']) {
    expect({ text, dissatisfied: isDissatisfied(text, worked) }).toEqual({ text, dissatisfied: false })
  }
  // The old phrases still need no context.
  expect(isDissatisfied('znowu źle', {})).toBe(true)
})

test('a turn did work when it edited a file or a page: Edit, Write, an MCP write', async () => {
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'mcp__vault-praca__write_file', 'mcp__notion__notion-update-page']) {
    expect({ tool, edit: isEditTool(tool) }).toEqual({ tool, edit: true })
  }
  for (const tool of ['Read', 'Grep', 'Bash', 'mcp__vault-praca__read_file', 'mcp__notion__notion-search']) {
    expect({ tool, edit: isEditTool(tool) }).toEqual({ tool, edit: false })
  }
})

test('graphic work is Sonnet, file and folder steps Haiku unless destructive, and a choice is advice', async () => {
  for (const p of ['zrób mi 30 nowych szablonów ulotek w pdf', 'przygotuj grafikę na LinkedIn', 'Zaprojektuj plakat na festyn', 'wygeneruj pdf-y z ofert', 'create a slide deck for the board']) {
    expect({ p, tier: heuristic(p, false)?.tier }).toEqual({ p, tier: 'sonnet' })
  }
  for (const p of ['zrób mi foldery na każdy miesiąc', 'skopiuj te pliki do nowego folderu', 'posortuj pliki w folderze Pobrane według daty', 'move these files to the archive folder']) {
    expect({ p, tier: heuristic(p, false)?.tier }).toEqual({ p, tier: 'haiku' })
  }
  // A delete, wipe or overwrite is never auto-Haiku, even next to an exact file step, and its size does not lift it.
  for (const p of ['usuń wszystkie pliki tymczasowe z folderu', 'skasuj folder dist', 'nadpisz pliki w folderze build', 'rm -rf node_modules', 'wipe the cache folder', 'przenieś pliki do archiwum i usuń stare foldery']) {
    expect({ p, tier: heuristic(p, false)?.tier }).toEqual({ p, tier: 'sonnet' })
  }
  // A plain "usuń" in a sheet is still one exact step; a code move into a new file is not a file operation.
  expect(heuristic('Usuń duplikaty w tym CSV', false)?.tier).toBe('haiku')
  expect(heuristic('przenieś funkcję do nowego pliku', false)?.tier).not.toBe('haiku')
  for (const p of ['lepiej wykorzystać everos czy notion?', 'co lepsze: notion czy obsidian?', 'czy warto przejść na Postgres?', 'Postgres vs MySQL for this app?', 'which is better, React or Vue?']) {
    expect({ p, tier: heuristic(p, false)?.tier, judgment: isJudgment(p) }).toEqual({ p, tier: 'sonnet', judgment: true })
  }
  // "vs" inside a task is not a choice; a choice of design is still architecture.
  expect(heuristic('fix the dev vs prod config mismatch', false)?.why ?? '').not.toContain('choice')
  expect(heuristic('Which of these two designs scales better?', false)?.tier).toBe('opus')
})

test('the new floor labels never let a delete reach Haiku, never block a lift and never outvote a hard label', async () => {
  const tier = (p: string) => heuristic(p, false)?.tier
  // A delete or overwrite next to a file step, whatever it clears ("je", "the old ones", "duplikaty"): Sonnet.
  for (const p of [
    'copy the config files to prod and overwrite the old ones',
    'przenieś pliki do archiwum i nadpisz istniejące',
    'move the files to backup, overwriting existing ones',
    'posortuj pliki w Pobranych i usuń duplikaty',
    'move the photos to the NAS and delete them from the laptop',
    'przenieś zdjęcia na dysk i skasuj je z telefonu',
    'skopiuj pliki na pendrive, a potem wyczyść oryginały',
    'zrób foldery na każdy miesiąc i usuń puste',
    'rename the files and remove the originals',
  ]) {
    expect({ p, tier: tier(p) }).toEqual({ p, tier: 'sonnet' })
  }
  // A delete beside wide work lifts as that work does.
  for (const p of ['przepisz cały projekt na TypeScript i usuń stare pliki js', 'refactor every module in the repo and delete the old files', 'migrate the whole codebase to ESM and remove the build folder']) {
    expect({ p, tier: tier(p) }).toEqual({ p, tier: 'opus' })
  }
  // A diagnosis, a design of software, a hard choice stay Opus, whatever delete, template or choice is in them.
  for (const p of [
    'dlaczego build się wywala po usunięciu folderu dist?',
    'why does the app crash when I delete a file?',
    'zaprojektuj system szablonów e-mail dla platformy multi-tenant',
    'zaprojektuj architekturę mikroserwisów i przygotuj prezentację dla zarządu',
    'zaprojektuj architekturę generatora pdf',
    'lepiej mikroserwisy czy monolit dla naszej architektury?',
    'czy lepiej użyć mutexa czy kanału, żeby uniknąć race condition?',
  ]) {
    expect({ p, tier: tier(p) }).toEqual({ p, tier: 'opus' })
  }
  // Code moved into files or a configurable directory is a code edit, not a chore on the disk.
  for (const p of [
    'przenieś komponenty do osobnych plików',
    'move the hooks into separate files and update the imports',
    'move the utility files into a shared package and update all imports',
    'make the directory configurable via an env var',
    'create a directory service in Go with LDAP sync',
    'set up the folder structure for a new Next.js app with auth and i18n',
  ]) {
    expect({ p, tier: tier(p) }).not.toEqual({ p, tier: 'haiku' })
  }
  // Graphic work is Sonnet however many copies; a list, a summary or a translation of a PDF makes nothing.
  for (const p of ['zrób projekt plakatu dla wszystkich oddziałów', 'przygotuj projekt ulotki dla wszystkich klientów', 'make a slide deck summarizing all projects this quarter']) {
    expect({ p, tier: tier(p) }).toEqual({ p, tier: 'sonnet' })
  }
  for (const p of ['make a list of all the templates in the repo', 'zrób listę wszystkich szablonów w repo']) {
    expect({ p, tier: tier(p) }).not.toEqual({ p, tier: 'opus' })
  }
  for (const p of ['zrób podsumowanie tego pdf-a', 'przygotuj tłumaczenie prezentacji na angielski']) {
    expect({ p, tier: tier(p) }).toEqual({ p, tier: 'haiku' })
  }
  // "Lepiej" as an adverb and "sprawdź czy" ask for no choice.
  for (const p of ['sformatuj ten plik lepiej i sprawdź czy lint przechodzi', 'przetłumacz to lepiej i sprawdź czy brzmi naturalnie']) {
    expect({ p, tier: tier(p), why: heuristic(p, false)?.why.includes('choice') }).toEqual({ p, tier: 'haiku', why: false })
  }
  // "W tym projekcie", "in this project" only say where the work is: one file under "all" is not lifted.
  for (const p of ['W tym projekcie dodaj testy jednostkowe dla wszystkich funkcji w utils.ts', 'In this project, add tests for all endpoints in api.ts', 'w repo backend dodaj testy dla wszystkich funkcji w utils.ts']) {
    expect({ p, tier: tier(p) }).toEqual({ p, tier: 'sonnet' })
  }
})

test('after a turn of work, quotes, checks, praise and new tasks that name a failure are no miss', async () => {
  for (const lastTurn of [{ steps: 4, edited: true }, { steps: 3, edited: false }]) {
    for (const text of [
      "translate 'wrong password' into German",
      'uruchom testy i sprawdź czy nic się nie zepsuło',
      'run the tests and make sure nothing is broken',
      'nie jest źle, teraz dodaj eksport do CSV',
      "it works now, why didn't it before?",
      "dodaj komunikat 'Coś poszło nie tak' do formularza logowania",
      'teraz dodaj walidację, żeby źle wpisany NIP pokazywał błąd',
      'add a test that wrong passwords are rejected',
      'napraw broken links w README',
      'dodaj obsługę sytuacji, gdy API nie działa',
      'ok, teraz obsłuż przypadek gdy plik nie otwiera się',
      'why not use redis instead?',
    ]) {
      expect({ text, lastTurn, miss: isDissatisfied(text, { lastTurn }) }).toEqual({ text, lastTurn, miss: false })
    }
  }
  // A fix pointed back at the answer is still a miss.
  expect(isDissatisfied('napraw to, nie działa', { lastTurn: { steps: 3, edited: true } })).toBe(true)
})

test('"all" and "every" lift the tier only over a wide scope or several code files', async () => {
  // More of the same work in one file: no lift.
  for (const p of ['Dodaj testy jednostkowe dla wszystkich funkcji w utils.ts', 'add tests for all endpoints in api.ts', 'popraw cały tekst tego maila']) {
    const v = heuristic(p, false)
    expect({ p, tier: v?.tier, large: v?.why.includes('large scope') }).toEqual({ p, tier: v?.tier, large: false })
    expect({ p, tier: v?.tier }).not.toEqual({ p, tier: 'opus' })
  }
  // A project, a repo, every module, the whole code, two code files: the same words still lift.
  for (const p of ['przepisz cały projekt na TypeScript', 'refactor every module in the repo', 'Dodaj testy jednostkowe dla wszystkich funkcji w całym projekcie', 'add tests for all functions in a.ts and b.ts']) {
    const v = heuristic(p, false)
    expect({ p, tier: v?.tier, large: v?.why.includes('large scope') }).toEqual({ p, tier: 'opus', large: true })
  }
  // Depth and stakes lift on their own, as before; "call" is no "cały".
  expect(heuristic('Streść cały raport', false)?.tier).toBe('sonnet')
  expect(heuristic('Write a comprehensive SQL query for the sales report', false)?.why).toContain('large scope')
  expect(heuristic('call the payments API from the checkout service', false)?.why ?? '').not.toContain('large scope')
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

test('app wrappers and pasted terminal sessions are not the task; a pasted brief is', () => {
  expect(heuristic('<system-reminder>\nplan the architecture, security audit of auth\n</system-reminder>', false)).toBeUndefined()
  expect(heuristic('<task-notification>\n<result>security review: root cause in 18 files a.ts b.ts c.ts d.ts</result>\n</task-notification>', false)).toBeUndefined()
  expect(heuristic('\n\n<pasted_content id="1">\nroot@srv:/opt/psc# docker compose logs\nmigration plan step failed\n</pasted_content>', false)).toBeUndefined()
  expect(heuristic('<pasted_content id="2">\nZaplanuj migrację bazy bez przestoju\n</pasted_content>', false)?.tier).toBe('opus')
  expect(isFollowUp('<task-notification>done</task-notification>')).toBe(false)
  expect(clean('tak <system-reminder>x</system-reminder> rób')).toBe('tak   rób')
})

test('mechanical reading is Haiku in both languages, and its scope does not lift the tier', () => {
  for (const p of [
    'znajdź wszystkie użycia parsePrice w całym repo',
    'find all usages of parsePrice across the codebase',
    'gdzie jest używana funkcja formatDate?',
    'uruchom testy i powiedz co nie przechodzi',
    'run the tests and report what fails',
    'przejrzyj logi z serwera i wypisz błędy',
    'przetłumacz wszystkie pliki w docs/ na angielski',
  ]) {
    expect({ p, tier: heuristic(p, false)?.tier }).toEqual({ p, tier: 'haiku' })
  }
})

test('debugging, design, security, decisions and reviews are judgment, never Haiku work', () => {
  for (const p of ['debug why the login fails', 'dlaczego to się wywala', 'zaprojektuj schemat bazy', 'oceń ten kod', 'which approach is better?', 'czy warto przejść na Postgres?', 'security audit of the api', 'zrób code review']) {
    expect({ p, judgment: isJudgment(p) }).toEqual({ p, judgment: true })
  }
  for (const p of ['znajdź wszystkie użycia parsePrice', 'uruchom testy i podaj wynik', 'rename getUser to fetchUser']) {
    expect({ p, judgment: isJudgment(p) }).toEqual({ p, judgment: false })
  }
})
