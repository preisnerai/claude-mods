# claude-mods: przegląd (01)

Dla osoby, która nie zna projektu. Stan z kodu 2026-11-13. Fakty mają odnośniki `plik:linia` (ścieżki względem korzenia repo, dalej "repo modów"). Dokumentacja jest w repo: przeniesiona do repo 2026-11-13, jeszcze niezacommitowana (czeka na zgodę właściciela; commit tylko na osobnej gałęzi, nie na `claude/model-router-1-12-1`); czego nie sprawdzono, oznaczono "niezweryfikowane". Dostępy: `08_DOSTEPY.md`.

## 1. Co tu jest

Korzeń repo to jedno repozytorium git (remote `preisnerai/claude-mods` na GitHubie) z marketplace'em modów do Claude Code i dwoma modami (pluginami) (`.claude-plugin/marketplace.json`):

| Mod | Wersja | Po co |
|---|---|---|
| `model-router` | 1.13.0 (`model-router/.claude-plugin/plugin.json`) | obniża koszt sesji Claude Code: kieruje prompty do Haiku, Sonneta albo Opusa wg potrzeby i rachunku cache, kompresuje wyjście Basha, skraca odpowiedzi |
| `find-mod` | 0.1.1 (`find-mod/.claude-plugin/plugin.json`) | wyszukiwarka modów do Claude Code na GitHubie: z opisu albo z kontekstu sesji; potrafi też zainstalować wybrany mod i zostawić autorowi gwiazdkę |

Oba mody są napisane w TypeScript (`hooks/*.ts`, `hooks/register.tsx`), bez zależności npm i bez serwera ani binarki (README.md, sekcja Install; zero zależności zgodnie z odznaką w README). W repo są poza tym katalogi robocze narzędzi (`.codegraph`, `.omo`, niezweryfikowane po przeniesieniu) i `docs/`.

## 2. Jak działają (w skrócie)

Mod to moduł rejestrujący hooki silnika Claude Code: `hooks/hooks.json` wskazuje `./register.tsx`, a ten eksportuje `register(on, options)` (`find-mod/hooks/register.tsx:63`, `model-router/hooks/register.tsx:1453`). W środku:

- `model-router` podpina się pod cykl promptu: `prompt.submit` (routing), `turn.start`, `turn.step`, `turn.complete` (rozliczenie), `agent.spawn` i `tool.call` (crew, eskalacja), `session.append` (kompresja wyjścia narzędzi), `prompt.compose` (sekcja stylu), `session.compact` (auto-kompakt), `ui.render` (panel i znacznik pod promptem), `session.end` (historia oszczędności). Rejestruje 16 komend `/router*` (`register.tsx:47-62`).
- `find-mod` rejestruje komendę `/find-mod` i narzędzie `search` (`mcp__find-mod__search`); wyszukuje przez API GitHub i ocenia dopasowanie tanim modelem (`find-mod/hooks/search.ts`, `register.tsx`).

Szczegóły i diagramy: `02_ARCHITEKTURA_BLUEPRINT.md`.

## 3. Jak zainstalować i odświeżyć

W terminalu Claude Code (README.md, sekcja Install):

```
/plugin marketplace add preisnerai/claude-mods
/plugin install model-router@claude-mods
/plugin install find-mod@claude-mods
```

Z powłoki: `claude plugin marketplace add preisnerai/claude-mods`, potem `claude plugin install model-router@claude-mods`. Odświeżenie do nowej wersji i pełna procedura rozwojowa: `06_RUNBOOK_PRZEKAZANIE.md`. Aplikacja desktopowa: opis w README.md (nie sprawdzano w UI).

## 4. Zasady (z kodu i dokumentów)

1. Działa po instalacji bez konfiguracji, rozsądne wartości domyślne; zero nowych zależności; nie zmienia promptu systemowego w trakcie sesji (żeby nie przebudować cache) (`model-router/ROADMAP.md`, "Zasady dla każdego dodatku").
2. Router nigdy nie wysyła `max` ani `ultracode` jako effort; maksimum to `xhigh` (`plugin.json`, opis `haikuEffort`).
3. Oszczędności i płatne podniesienia jakości są liczone osobno (`hooks/cost.ts`).
4. `find-mod` niczego nie instaluje bez jawnego potwierdzenia (`--yes`), a opisy repozytoriów z GitHuba traktuje jako dane, nie instrukcje (`find-mod/hooks/register.tsx`, `HANDOFF`; `install.ts`).
5. Klucz `layaApiKey` jest oznaczony `sensitive` w konfiguracji użytkownika (`model-router/.claude-plugin/plugin.json`); nie wolno go wpisywać do repo.

## 5. Rozmiar i jakość (zmierzone 2026-11-13)

`model-router`: 10 plików w `hooks/` (łącznie około 4,9 tys. linii, w tym `register.tsx` 2228), 10 plików testów; `find-mod`: 3 pliki kodu i 2 pliki testów. `claude plugin test`: 223 testy przechodzą w `model-router`, 16 w `find-mod`; `claude plugin validate` przechodzi dla marketplace'u i obu modów (Claude Code 2.1.322).

## 6. Rzeczy spoza repozytorium i uwagi

- Stan lokalny użytkownika modu: `~/.claude/model-router/` (`history.jsonl`, `decisions.json`, `tee/`; `CLAUDE_CONFIG_DIR` ma pierwszeństwo, `register.tsx:371-399`).
- Repozytorium ma niezacommitowane zmiany (README, `classify.ts`, `crew.ts`, `register.tsx`, testy, `types/index.d.ts`) na gałęzi `claude/model-router-1-12-1`, a `main` jest osobno; opisane w `06`, sekcja 7. Ta dokumentacja opisuje stan katalogu roboczego; sama leży w repo (`docs/`, `AGENTS.md`, `CLAUDE.md`), niezacommitowana.
- `.claude-plugin/types/` jest generowane przez CLI i ignorowane (`.gitignore`); `tsconfig.json` modów je rozszerza.
- `README.md` mówi o jednym modzie (model-router) i odsyła do reszty w sekcji "More mods in this repo"; `find-mod` nie ma własnego README.
- Opisy `find-mod` (komunikaty, komentarze) są po polsku, `model-router` po angielsku.
