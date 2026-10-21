![model-router](.github/header.svg)

<p align="center"><a href="README.md">English</a> · <b>Polski</b></p>

**model-router** to mod do Claude Code, który obniża koszt sesji w trzech miejscach naraz:

| | Co robi | Gdzie oszczędza |
|---|---|---|
| 🔀 **Routing** | Każdy prompt idzie do Haiku, Sonneta albo Opusa, zależnie od tego, czego wymaga. Lokalne reguły po polsku i angielsku rozpoznają jasne prompty bez wywołania modelu; tylko niejasne trafiają do sędziego Haiku (ok. $0.0001 za prompt). | Mniej tokenów Opusa |
| 🧮 **Rachunek cache** | Zmiana modelu wyrzuca prompt cache: następne zapytanie czyta całą rozmowę od nowa po cenie zapisu. Przed każdym zejściem na tańszy model router wycenia turę na obu modelach przy Twoim rozmiarze kontekstu i stanie cache, i schodzi tylko wtedy, gdy to się opłaca. | Żadne zejście na tańszy model nie kosztuje więcej, niż oszczędza |
| 🗜️ **Kompresja** | Wyjście Basha kurczy się, zanim trafi do rozmowy, w stylu rtk: bez pasków postępu i zaliczonych testów, identyczne powtórzenia zwinięte w licznik, każda linia z błędem zachowana. Zawartość plików, diffy i dane przechodzą nietknięte. Pełne wyjście zostaje na dysku (`~/.claude/model-router/tee/`, ostatnie 200). Z zainstalowanym [rtk](https://github.com/rtk-ai/rtk) zwykłe uruchomienia `cargo test`, `pytest`, `tsc`, `mypy` i `go build` idą przez `rtk pipe`; podsumowanie, które gubi błędy, jest odrzucane. | Mniej wejścia w każdym kolejnym zapytaniu |
| ✂️ **Krócej** | Jedna krótka sekcja promptu systemowego: bez wstępów, podsumowań i formułek na koniec, komendy w jednym wywołaniu, czytanie fragmentów plików. Tryb `adhd` zaczyna od następnej akcji, wg [i-have-adhd](https://github.com/ayghri/i-have-adhd). | Mniej tokenów wyjściowych, które kosztują 5× więcej niż wejściowe |

Panel **Model router** (w aplikacji desktopowej obok rozmowy) pokazuje na żywo bieżący model, oszczędność i tury na model.

`/router` pokazuje, ile zaoszczędził routing (w dolarach) i ile tokenów kompresja trzymała poza kontekstem, dla tej sesji i łącznie.

## Instalacja

W sesji Claude Code w terminalu:

```
/plugin install model-router --marketplace preisnerai/claude-mods
```

Odpowiedz `y`, żeby dodać marketplace, i wybierz zakres. Bez serwera, bez binarki, bez klucza API. Z powłoki: `claude plugin install model-router --marketplace preisnerai/claude-mods`. W aplikacji desktopowej: **+** obok pola promptu → Plugins → Add marketplace `preisnerai/claude-mods` → Add plugin.

## Dlaczego routing musi liczyć cache

Router, który zmienia model przy każdym prompcie, potrafi **dokładać** do rachunku. Prompt cache należy do jednego modelu: po zmianie następne zapytanie płaci za zapis całej rozmowy, 2× ceny wejścia przy godzinnych wpisach, które zapisuje Claude Code. Sam prompt systemowy i narzędzia to dziesiątki tysięcy tokenów, więc nawet młoda sesja ma co stracić.

Liczby z modelu kosztów routera, dla sesji na Claude Opus 5.5 z ciepłym cache:

| Kontekst w cache | Opus → Sonnet, zwykłe zadanie | Opus → Haiku, szybkie zadanie |
|---:|---|---|
| 40 tys. tokenów | **zostaje na Opusie**: remis (+$0.002) | **przełącza**: oszczędza $0.047 |
| 100 tys. | **zostaje**: +$0.23 | **przełącza**: −$0.051 |
| 150 tys. | **zostaje**: +$0.42 | **zostaje**: +$0.063 (stawka Haiku powyżej 100 tys.) |
| 400 tys. | **zostaje**: +$1.37 | **zostaje**: +$0.23 |

Opus 5.5 i Sonnet 5.5 czytają cache po tej samej cenie $0.20/MTok, więc w środku sesji Sonnet oszczędza tylko na wyjściu, a zapis rozmowy do jego cache kosztuje więcej. Haiku 5.5 jest 40× tańszy od Opusa na wejściu do 100 tys. tokenów, więc zejście na niego opłaca się nawet z zapisem; powyżej 100 tys. płaci stawkę 5× wyższą i ciepły Opus znów jest tańszy. Gdy cache modelu wygasł (godzina bezczynności), obie strony płacą za zapis i wygrywa tańszy model. Cache zależy też od effort, więc na Twoim modelu router zostawia Twój `/effort`.

Trudniejsze zadania to kwestia jakości, nie pieniędzy: domyślnie router podnosi poziom, gdy prompt tego wymaga, i pokazuje koszt zmiany. Ustaw `escalate: suggest`, żeby router tylko podpowiadał w linii statusu.

## Jak prompt jest kierowany

1. Prefiks `!haiku`, `!sonnet`, `!opus` (lub `!fable`) wymusza model; prefiks jest usuwany z promptu.
2. Krótka kontynuacja („ok”, „dalej”, „zrób to”) zostaje na bieżącym modelu.
3. Lokalne reguły PL/EN (0 tokenów): tłumaczenie, literówka, zmiana nazwy → Haiku; nowa funkcja, test, refaktor → Sonnet; „dlaczego… nie działa”, wyciek pamięci, architektura, audyt bezpieczeństwa → Opus.
4. Niejasne prompty: opcjonalnie [laya-serve](https://github.com/NandhaKishorM/laya) lokalnie, potem sędzia Haiku.
5. Rachunek cache decyduje, czy przełączyć.

Dodatkowo: ręczny `/model` wyłącza routing do końca sesji (`/router on` przywraca), a automatyczny fallback silnika tylko go wstrzymuje do następnego promptu; trzy nieudane lub identyczne wywołania narzędzi z rzędu podnoszą poziom; subagent general-purpose bez wskazanego modelu dostaje tańszy poziom tury (inne typy agentów mogą mieć własny model i nie są ruszane); skille (`/mój-skill`) są kierowane po wpisanej linii i opisie komendy; prompty wpisane w trakcie tury są kierowane, gdy zaczyna się ich tura.

Licznik oszczędności wycenia każde zapytanie dwa razy: tak, jak poszło, i tak, jak poszłoby na Twoim `/model` z jego własnym cache. Zapis cache po przełączeniu liczy się więc jako koszt.

## Tryb crew: jeden orkiestrator, trzech ciepłych workerów

Ustaw `mode: crew`, a sesja główna zostaje na jednym modelu-orkiestratorze (domyślnie Sonnet). Przechodzi na niego raz, przy pierwszym prompcie, i potem już się nie zmienia, więc jej cache nie przepada. Pracę wymagającą kilku wywołań narzędzi wykonują trwałe workery: `worker-haiku` (szukanie, czytanie kodu, podsumowania, komendy), `worker-sonnet` (jasne funkcje, poprawki, testy) i `worker-opus` (trudne bugi, architektura, audyty).

Worker zachowuje kontekst między zadaniami: kolejne zadanie orkiestrator wysyła mu przez `SendMessage` (zakończony worker wznawia pracę z tym, co wie). Workery same wykonują zadanie (nie mogą uruchamiać agentów) i odsyłają raport do 10 linii zamiast całych plików. Orkiestrator ma zlecać pracę tylko wtedy, gdy zajmie ona co najmniej 3 wywołania narzędzi, bo przekazanie i raport kosztują go dwa jego własne zapytania. Podpowiedź „oddaj workerowi” dostaje tylko przy zadaniach trudniejszych niż jego model. Gdy model odpala drugiego workera tego samego typu, mod odmawia i wskazuje istniejącego, chyba że ten urósł albo ostygł na tyle, że nowy wyjdzie taniej. `!haiku …` / `!opus …` oddaje cały prompt workerowi, a `!fable …` idzie do `worker-opus`. `/router off` wyłącza crew w tej sesji.

Przetestowane na żywo: dwa zadania dla `worker-haiku` w jednej sesji uruchomiły jednego workera, drugie poszło przez `SendMessage`, a koszt Haiku wyniósł $0.0023.

## Komendy

| | |
|---|---|
| `/router` | aktualny model, oszczędności w sesji i łącznie, przełączenia i wstrzymania, kompresja |
| `/router style terse\|adhd\|off` | styl odpowiedzi w tej sesji |
| `/router off` · `/router on` | wyłącz lub włącz routing w tej sesji |
| `/router log` | ostatnie 50 decyzji jako JSON, do strojenia |
| `/router reset` | wyczyść sumy, wyuczone profile tur i log |

Ustawienia (`mode`, `orchestrator`, `escalate`, `style`, `compress`, `useRtk`, `cacheTtl`, `judge`, `layaUrl`, `layaApiKey`, `enableFable`, effort per poziom, `showNote`) pojawiają się przy instalacji i w `/config`. Pełny opis w [README po angielsku](README.md#settings).

## find-mod

> Wersja 0.1, wczesna: logika przetestowana na danych testowych, bez sprawdzenia na żywym GitHubie. Zgłaszaj, co nie działa.

Wyszukiwarka modów na GitHubie. `/find-mod opis tego, czego potrzebujesz` szuka od razu; samo `/find-mod` każe Claude'owi ustalić potrzebę z kontekstu sesji i dopytać, jeśli nie jest pewny. Claude może też sam wywołać narzędzie `mcp__find-mod__search`.

Jak wybiera: opis → angielskie słowa kluczowe → GitHub Search (tematy `claude-mod`, `claude-code-mod`, `claude-code-plugin` oraz szersze zapytanie tekstowe, bez zarchiwizowanych repo) → ocena dopasowania 0–3 przez Haiku (bez wglądu w gwiazdki; bez modelu: dopasowanie słów kluczowych) → spośród pasujących (ocena ≥ 2) wygrywa ten z największą liczbą gwiazdek. Zwraca też do 4 alternatyw.

Bez tokenu GitHub dopuszcza 10 wyszukiwań na minutę; przy limicie mod mówi to wprost zamiast udawać brak wyników. Lista tematów jest na górze `find-mod/hooks/search.ts` (`TOPICS`), model w `find-mod/hooks/register.tsx` (`JUDGE`). Testy: `claude plugin test find-mod`.

### Instalacja i gwiazdka

- `/find-mod install owner/repo` (albo `owner/repo:plugin`, gdy repo ma kilka) pokazuje podgląd i niczego nie instaluje. Dopiero `... --yes` instaluje (`claude plugin install <plugin> --marketplace owner/repo`). Repo musi mieć `.claude-plugin/marketplace.json`; bez niego mod mówi, że nie zainstaluje automatycznie.
- Gwiazdka dla autora (`gh api -X PUT user/starred/owner/repo`) zależy od ustawienia `autoStar`: `ask` (domyślnie) po instalacji tylko proponuje `/find-mod star owner/repo`, `always` daje ją sama po udanej instalacji, `never` nic nie robi. Bez zalogowanego `gh` mod podaje link do ręcznego oddania gwiazdki. Claude nie ma narzędzia do instalacji: instalujesz tylko Ty, własnym poleceniem.

### Instalacja

`/plugin marketplace add preisnerai/claude-mods`, potem `/plugin install find-mod` (albo `model-router`).

Żeby Twój mod był znajdowany: dodaj do repozytorium temat `claude-mod` i plik `.claude-plugin/marketplace.json`.

## Podziękowania

- [laya-router](https://github.com/marcreichel/laya-router), Marc Reichel (MIT): routing na klasyfikatorze, koszt zmiany modelu w trakcie sesji, pierwszeństwo `/model`, wykrywanie zapętlenia, log kalibracyjny i opisy poziomów dla laya-serve.
- [rtk](https://github.com/rtk-ai/rtk), rtk-ai: strategie kompresji wyjścia, zaimplementowane tu od nowa, i binarka wywoływana, gdy jest zainstalowana. Kod rtk nie jest dołączony.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd), Ayoub Ghriss (MIT): zasady stylu `adhd`.

## Licencja

[MIT](LICENSE)
