# claude-mods

Mody (pluginy) do Claude Code. Każdy mod to osobny folder.

## model-router

Ocenia każdy prompt przez Haiku i wybiera model dla tury: proste zadania na Haiku, średnie na Sonnet, złożone na Opus. Wymuszenie ręczne: prefiks `!haiku`, `!sonnet` albo `!opus` przed promptem.

Ustawienia modeli są na górze `model-router/hooks/register.tsx` (stałe `MODEL` i `JUDGE`).

## find-mod

> Wersja 0.1, wczesna: logika przetestowana na danych testowych, bez sprawdzenia na żywym GitHubie. Zgłaszaj, co nie działa.

Wyszukiwarka modów na GitHubie. `/find-mod opis tego, czego potrzebujesz` szuka od razu; samo `/find-mod` każe Claude'owi ustalić potrzebę z kontekstu sesji i dopytać, jeśli nie jest pewny. Claude może też sam wywołać narzędzie `mcp__find-mod__search`.

Jak wybiera: opis → angielskie słowa kluczowe → GitHub Search (tematy `claude-mod`, `claude-code-mod`, `claude-code-plugin` oraz szersze zapytanie tekstowe, bez zarchiwizowanych repo) → ocena dopasowania 0–3 przez Haiku (bez wglądu w gwiazdki; bez modelu: dopasowanie słów kluczowych) → spośród pasujących (ocena ≥ 2) wygrywa ten z największą liczbą gwiazdek. Zwraca też do 4 alternatyw.

Bez tokenu GitHub dopuszcza 10 wyszukiwań na minutę; przy limicie mod mówi to wprost zamiast udawać brak wyników. Lista tematów jest na górze `find-mod/hooks/search.ts` (`TOPICS`), model w `find-mod/hooks/register.tsx` (`JUDGE`). Testy: `claude plugin test find-mod`.

### Instalacja i gwiazdka

- `/find-mod install owner/repo` (albo `owner/repo:plugin`, gdy repo ma kilka) pokazuje podgląd i niczego nie instaluje. Dopiero `... --yes` instaluje (`claude plugin install <plugin> --marketplace owner/repo`). Repo musi mieć `.claude-plugin/marketplace.json`; bez niego mod mówi, że nie zainstaluje automatycznie.
- Gwiazdka dla autora (`gh api -X PUT user/starred/owner/repo`) zależy od ustawienia `autoStar`: `ask` (domyślnie) po instalacji tylko proponuje `/find-mod star owner/repo`, `always` daje ją sama po udanej instalacji, `never` nic nie robi. Bez zalogowanego `gh` mod podaje link do ręcznego oddania gwiazdki. Claude nie ma narzędzia do instalacji: instalujesz tylko Ty, własnym poleceniem.

## Instalacja tego repo

`/plugin marketplace add preisnerai/claude-mods`, potem `/plugin install find-mod` (albo `model-router`).

Żeby Twój mod był znajdowany: dodaj do repozytorium temat `claude-mod` i plik `.claude-plugin/marketplace.json`.
