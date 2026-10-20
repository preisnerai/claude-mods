# claude-mods

Mody (pluginy) do Claude Code. Każdy mod to osobny folder.

## model-router

Ocenia każdy prompt przez Haiku i wybiera model dla tury: proste zadania na Haiku, średnie na Sonnet, złożone na Opus. Wymuszenie ręczne: prefiks `!haiku`, `!sonnet` albo `!opus` przed promptem.

Ustawienia modeli są na górze `model-router/hooks/register.tsx` (stałe `MODEL` i `JUDGE`).

## find-mod

Wyszukiwarka modów na GitHubie. `/find-mod opis tego, czego potrzebujesz` szuka od razu; samo `/find-mod` każe Claude'owi ustalić potrzebę z kontekstu sesji i dopytać, jeśli nie jest pewny. Claude może też sam wywołać narzędzie `mcp__find-mod__search`.

Jak wybiera: opis → angielskie słowa kluczowe → GitHub Search (tematy `claude-mod`, `claude-code-mod`, `claude-code-plugin` oraz szersze zapytanie tekstowe, bez zarchiwizowanych repo) → ocena dopasowania 0–3 przez Haiku (bez wglądu w gwiazdki; bez modelu: dopasowanie słów kluczowych) → spośród pasujących (ocena ≥ 2) wygrywa ten z największą liczbą gwiazdek. Zwraca też do 4 alternatyw.

Bez tokenu GitHub dopuszcza 10 wyszukiwań na minutę; przy limicie mod mówi to wprost zamiast udawać brak wyników. Lista tematów jest na górze `find-mod/hooks/search.ts` (`TOPICS`), model w `find-mod/hooks/register.tsx` (`JUDGE`). Testy: `claude plugin test find-mod`.

Jeszcze nie ma: instalacji z poziomu moda i opcjonalnej gwiazdki dla autora (planowana za zgodą użytkownika).
