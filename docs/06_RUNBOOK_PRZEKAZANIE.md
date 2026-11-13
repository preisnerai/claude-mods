# claude-mods: runbook i przekazanie (06)

Dla następcy. Bez sekretów: dostępy w `08_DOSTEPY.md`. Stan: 2026-11-13. Ścieżki względem korzenia repo (dalej "repo modów"). Dokumentacja jest w repo: przeniesiona do repo 2026-11-13, jeszcze niezacommitowana (czeka na zgodę właściciela; commit tylko na osobnej gałęzi, nie na `claude/model-router-1-12-1`). Przegląd: `01_PRZEGLAD.md`, architektura: `02_ARCHITEKTURA_BLUEPRINT.md`.

## 1. Co to jest (30 sekund)

Dwa mody do Claude Code w jednym repozytorium z marketplace'em: `model-router` (oszczędzanie tokenów przez routing modeli, kompresję i krótsze odpowiedzi) i `find-mod` (szukanie i instalacja modów z GitHuba). TypeScript, bez zależności npm, testy przez CLI Claude Code.

## 2. Wymagania i uruchomienie

Potrzebny jest Claude Code CLI (sprawdzono 2.1.322, `claude` w PATH); Node jest potrzebny tylko w CI (22). Nie ma `package.json` ani kroku budowania: silnik ładuje `hooks/register.tsx` wprost.

```bash
cd model-router                 # w korzeniu repo; albo find-mod
claude plugin validate .        # manifest i struktura
claude plugin test .            # testy: model-router 223, find-mod 16 (zielone 2026-11-13)
claude --plugin-dir .           # sesja z modem ładowanym z katalogu
```

Walidacja marketplace'u: `claude plugin validate .` z korzenia repo (zielona 2026-11-13). Testy uruchomiono na bieżącym katalogu roboczym (z niezacommitowanymi zmianami).

## 3. Instalacja i odświeżanie u użytkownika

```
/plugin marketplace add preisnerai/claude-mods
/plugin install model-router@claude-mods
/plugin install find-mod@claude-mods
```

Odświeżenie po nowej wersji: ponowna instalacja lub aktualizacja modu poleceniami `/plugin` (dokładna komenda aktualizacji: niezweryfikowane, sprawdź `claude plugin --help`). Wersję podnosi się w `.claude-plugin/plugin.json` modu. Użytkownik, który ma lokalny katalog modu, może go załadować flagą `--plugin-dir`.

## 4. Rozwój: typowe zadania

| Zadanie | Kroki |
|---|---|
| Zmiana reguły routingu | edytuj `model-router/hooks/classify.ts`, uruchom `claude plugin test model-router`; skopiuj źle skierowany prompt z `~/.claude/model-router/decisions.json` do korpusu w `tests/classify.test.ts` z właściwym tierem (cel zgodności 85 procent) |
| Aktualizacja cen | `model-router/hooks/cost.ts` i `PRICES_VERSION`; ceny to ceny list z października 2026 (`model-router/README.md`) |
| Nowy model | `model-router/hooks/register.tsx:36-41`, cennik w `cost.ts`, `JUDGE` w `find-mod/hooks/register.tsx` |
| Nowe ustawienie | `userConfig` w `plugin.json` i obsługa w `register` |
| Nowa wersja | podnieś `version` w `plugin.json`, zaktualizuj README i `ROADMAP.md`, uruchom walidację i testy |
| Nowy mod | `02`, sekcja 6 |

Zasady z `model-router/ROADMAP.md`: działa po instalacji bez konfiguracji, nie zmienia promptu systemowego w trakcie sesji, ma testy, zero nowych zależności.

## 5. Typowe awarie

| Objaw | Przyczyna i co zrobić |
|---|---|
| `claude plugin validate` zgłasza błąd manifestu | literówka w `plugin.json` lub `marketplace.json` (`source` musi wskazywać katalog modu) |
| Testy przestają przechodzić po aktualizacji Claude Code | API modów jest we wczesnym dostępie, CI śledzi bieżące wydanie (`test.yml`); sprawdź zmiany silnika |
| Typy nie rozwiązują się (`claude-code`) | `.claude-plugin/types/` jest generowane przez CLI i ignorowane; uruchom `claude plugin validate`/`test`, które je odtwarza (niezweryfikowane) |
| `/router` pokazuje zera po restarcie | stan siedzi w `~/.claude/model-router/` (`CLAUDE_CONFIG_DIR` ma pierwszeństwo); `/router reset` czyści |
| Źle skierowany prompt | `/router why`, `/router log`; ręcznie `!haiku`, `!sonnet`, `!opus`, `!+`, `!-`; potem korekta reguł (sekcja 4) |
| Router przełącza model i rachunek rośnie | rachunek cache: zmiana modelu przebudowuje cache; tryb `crew` (domyślny) go unika |
| `find-mod` zwraca 403 lub puste wyniki | limit zapytań GitHub API bez tokenu (niezweryfikowane); spróbuj później |
| `find-mod install` nic nie instaluje | bez `--yes` pokazuje tylko podgląd (`install.ts`, `register.tsx`) |

## 6. Gdzie są dane spoza repo

| Dane | Gdzie |
|---|---|
| Stan i historia oszczędności użytkownika | `~/.claude/model-router/` (`history.jsonl`, `decisions.json`, `tee/` z ostatnimi 200 skompresowanymi wynikami) na komputerze użytkownika |
| Klucz `layaApiKey` (opcjonalny) | konfiguracja użytkownika modu (oznaczona jako wrażliwa), nie repo |
| Kod i historia | GitHub `preisnerai/claude-mods` i lokalny klon (korzeń repo) |

<!-- HUMAN -->
DO UZUPEŁNIENIA przez właściciela: czy istnieje kopia poza GitHubem, kto publikuje nowe wersje i jak (tag, release), czy `layaUrl` (laya-serve) jest u kogoś używane.
<!-- /HUMAN -->

## 7. Stan repozytorium (2026-11-13)

Korzeń repo to katalog `claude-mods\claude-mods`; katalog nadrzędny `claude-mods\` nie jest repozytorium. Aktualna gałąź: `claude/model-router-1-12-1` (ostatni commit: "model-router 1.13.0" z 2026-11-05), są niezacommitowane zmiany w `README.md`, `README.pl.md`, `model-router/hooks/classify.ts`, `crew.ts`, `register.tsx`, testach i `types/index.d.ts` oraz nieśledzony `.claude/` (ustawienia lokalne) oraz nieśledzona, przeniesiona 2026-11-13 dokumentacja (`docs/`, `AGENTS.md`, `CLAUDE.md`). Są też gałęzie `main`, `claude/adoring-pascal-znldfd` i kilka zdalnych gałęzi roboczych oraz jeden stash (`etap0-backup`). Zmiany modelu-routera są osobną pracą właściciela: nie dotykaj ich przy pracy nad dokumentacją.

Dokumentacja została przeniesiona do repo 2026-11-13 i jest NIEZACOMMITOWANA. Commit wyłącznie na osobnej gałęzi (nie na `claude/model-router-1-12-1`, nie razem ze zmianami kodu) i dopiero po zgodzie właściciela. Manifest `docsync.json` ma ścieżki względem korzenia repo (odciśnięcie `stamp` jeszcze nie wykonane); `check --root .` uruchamiaj w korzeniu repo.

## 8. Moduły

| Moduł | Rola |
|---|---|
| `.claude-plugin/marketplace.json` | katalog modów (nazwa `claude-mods`, właściciel `preisnerai`) |
| `model-router/` | mod oszczędnościowy; `hooks/` (10 plików), `tests/` (10 plików), `README.md`, `ROADMAP.md`, `types/index.d.ts` |
| `find-mod/` | mod wyszukiwarki; `hooks/install.ts`, `search.ts`, `register.tsx` i testy obok |
| `.github/workflows/test.yml` | CI |
| `README.md`, `README.pl.md`, `LICENSE` (MIT) | dokumentacja użytkowa i licencja |

## 9. Decyzje i "dlaczego"

<!-- HUMAN -->
DO UZUPEŁNIENIA przez właściciela: dlaczego marketplace i mody pod kontem `preisnerai`, dlaczego tryb `crew` jest domyślny, plan na `ROADMAP.md` (etap 4: skrypty do powtarzalnej pracy), polityka wersjonowania.
<!-- /HUMAN -->

## 10. Ryzyka i bus factor

1. Mody zależą od wczesnego API silnika; zmiana po stronie Claude Code może je zepsuć.
2. Dużo logiki w `register.tsx` (2228 linii); zmiany tam wymagają pełnego przebiegu testów.
3. Niezacommitowana praca (kod i dokumentacja) i kilka gałęzi roboczych.
4. Jedna osoba i kod pisany z AI.

## 11. Plan pierwszego tygodnia

| Dzień | Zadanie | Wynik |
|---|---|---|
| 1 | Przeczytaj `01`, `02`, otwórz `mapa_wizualna.html`, zdobądź dostępy z `08_DOSTEPY.md` | wiesz, co jest |
| 2 | `claude plugin validate` i `test` dla obu modów, uruchom `claude --plugin-dir model-router` | zielone testy, mod działa lokalnie |
| 3 | Przeczytaj `model-router/README.md`, `README.md`; użyj `/router`, `/router why`, `/router-help` | rozumiesz działanie |
| 4 | Uporządkuj repo: niezacommitowane zmiany, gałęzie, stash (z właścicielem); zacommituj dokumentację na osobnej gałęzi (po zgodzie) | czysty stan repo |
| 5 | Mała zmiana (np. reguła w `classify.ts` z przypadkiem w korpusie), testy | cały cykl przećwiczony |
| 6-7 | Uzupełnij sekcje HUMAN, `/doc-sync` | dokumentacja aktualna |
