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
/plugin marketplace add preisnerai/claude-mods
/plugin install model-router@claude-mods
```

Bez serwera, bez binarki, bez klucza API. Z powłoki: `claude plugin marketplace add preisnerai/claude-mods`, potem `claude plugin install model-router@claude-mods`. W aplikacji desktopowej: **+** obok pola promptu → Plugins → Add marketplace `preisnerai/claude-mods` → Add plugin.

## Dlaczego routing musi liczyć cache

Router, który zmienia model przy każdym prompcie, potrafi **dokładać** do rachunku. Prompt cache należy do jednego modelu: po zmianie następne zapytanie płaci za zapis całej rozmowy, 2× ceny wejścia przy godzinnych wpisach, które zapisuje Claude Code. Sam prompt systemowy i narzędzia to dziesiątki tysięcy tokenów, więc nawet młoda sesja ma co stracić.

Liczby z modelu kosztów routera, dla sesji na Claude Opus 5.5 z ciepłym cache:

| Kontekst w cache | Opus → Sonnet, zwykłe zadanie | Opus → Haiku, szybkie zadanie |
|---:|---|---|
| 40 tys. tokenów | **przełącza**: oszczędza $0.024 | **przełącza**: oszczędza $0.047 |
| 100 tys. | **zostaje**: +$0.17 | **przełącza**: −$0.051 |
| 150 tys. | **zostaje**: +$0.34 | **zostaje**: +$0.063 (stawka Haiku powyżej 100 tys.) |
| 400 tys. | **zostaje**: +$1.16 | **zostaje**: +$0.23 |

Opus 5.5 czyta cache po $0.20/MTok, a Sonnet 5.5 po $0.10 (0.05×), więc Sonnet oszczędza na wyjściu i na odczycie cache: mała ciepła rozmowa zyskuje na przejściu, duża płaci więcej za przebudowę cache. Poniżej ok. 50 tys. tokenów przejście Opus → Sonnet się opłaca; powyżej koszt przebudowy jest większy. Haiku 5.5 jest 40× tańszy od Opusa na wejściu do 100 tys. tokenów, więc zejście na niego opłaca się nawet z zapisem; powyżej 100 tys. płaci stawkę 5× wyższą i ciepły Opus znów jest tańszy. Gdy cache modelu wygasł (godzina bezczynności), obie strony płacą za zapis i wygrywa tańszy model. Cache zależy też od effort, więc **zmiana effortu zrzuca cache tak samo jak zmiana modelu**; na Twoim modelu router zostawia Twój `/effort`, chyba że effort zadania nie kosztuje więcej.

Trudniejsze zadania to kwestia jakości, nie pieniędzy: domyślnie router podnosi poziom, gdy prompt tego wymaga, i pokazuje koszt zmiany. Ustaw `escalate: suggest`, żeby router tylko podpowiadał w linii statusu.

## Jak prompt jest kierowany

1. Prefiks `!haiku`, `!sonnet`, `!opus` (lub `!fable`) wymusza model; `!+` podnosi o jeden tier od bieżącego, `!-` obniża. Prefiks jest usuwany z promptu.
2. Krótka kontynuacja („ok”, „dalej”, „zrób to”) zostaje na bieżącym modelu. Niezadowolenie („znowu źle”, „popraw to”, „nie o to chodziło”) eskaluje o jeden tier.
3. Lokalne reguły PL/EN (0 tokenów): tłumaczenie, literówka, zmiana nazwy → Haiku; nowa funkcja, test, refaktor → Sonnet; „dlaczego… nie działa”, wyciek pamięci, architektura, audyt bezpieczeństwa → Opus. Reguły czytają też pracę nie-kodową: teksty, Excel/CSV, Notion/Confluence, Chrome i formularze, maile, API i automatyzacje. Prosty git (`push`, `commit`, `pull`, `fetch`, `status`) → Haiku; PR, force-push, rebase albo konflikt merge → Sonnet.
4. Research ma twardą politykę: proste sprawdzenie („sprawdź cenę”, „look up the price”) → Haiku; szerszy research („zbadaj temat”, „research rynku”, „porównaj rozwiązania”) → Sonnet. Research nigdy nie idzie do Opusa; „zbadaj wyciek pamięci” to debug, nie research.
5. Sygnały rozmiaru: cztery i więcej plików kodu, numerowane kroki, długi brief, stack trace, a także nieudane narzędzia w poprzedniej turze podnoszą zadanie. Negacje („nie refaktoruj”, „bez refaktoryzacji”) anulują słowo, którego dotyczą.
6. Niejasne prompty: opcjonalnie [laya-serve](https://github.com/NandhaKishorM/laya) lokalnie, potem sędzia Haiku z progiem pewności; poniżej progu zostaje bieżący model.
7. Rachunek cache decyduje, czy przełączyć model albo effort.

Dodatkowo: ręczny `/model` wyłącza routing do końca sesji (`/router on` przywraca), a automatyczny fallback silnika tylko go wstrzymuje do następnego promptu; trzy nieudane lub identyczne wywołania narzędzi z rzędu podnoszą poziom; subagent general-purpose bez wskazanego modelu dostaje tańszy poziom tury (inne typy agentów mogą mieć własny model i nie są ruszane); skille (`/mój-skill`) są kierowane po wpisanej linii i opisie komendy; prompty wpisane w trakcie tury są kierowane, gdy zaczyna się ich tura.

**Effort per zadanie** (`effortMode: auto`): każdy poziom ma bazowy effort, a zadanie przesuwa go o krok: pewna diagnoza, architektura czy bezpieczeństwo w górę, tłumaczenie czy zmiana nazwy w dół. Desktop nazywa `xhigh` **Extra**. Cache zależy od modelu *i* effort, więc zmiana effortu przechodzi ten sam rachunek co przełączenie modelu: na Twoim modelu Twój `/effort` zostaje, póki cache jest ciepły. `effortMode: task` zawsze bierze effort zadania, nawet gdy przebudowa cache kosztuje więcej; `effortMode: fixed` to stary effort per poziom. Router nigdy nie wysyła `max` ani `ultracode` jako effortu. Workery crew zachowują effort, z którym je zarejestrowano.

**Ultracode** dla najtrudniejszych zadań (pewny werdykt Opus/Fable: architektura, niewyjaśniony błąd, audyt, szeroka migracja, incydent produkcyjny): `suggest` podpowiada słowo `ultracode` w linii statusu, `auto` dopisuje je do promptu (workflow wieloagentowy: droższa tura, ale często szybciej i taniej w sumie), `off` milczy. W Desktopie **Ultracode** to opcja nad Maxem w pickerze effortu; router automatyzuje ten przełącznik zamiast wysyłać Max.

**Uczy się Ciebie** (`adapt: on`): `!poziom`, `!+` lub `!-` wbrew regułom, `/model` lub `/effort` zmieniony zaraz po skierowanym prompcie i eskalacja po nieudanych narzędziach przesuwają dany rodzaj zadania (jego regułę albo `judge`) o maks. ±2 poziomy lub kroki effort. Korekty wygasają (połowa po dwóch tygodniach) i zostają na Twoim komputerze; `/router` je pokazuje, `/router reset` czyści.

Licznik oszczędności wycenia każde zapytanie dwa razy: tak, jak poszło, i tak, jak poszłoby na Twoim `/model` z jego własnym cache. Zapis cache po przełączeniu liczy się więc jako koszt.

## Tryb crew: jeden orkiestrator, trzech ciepłych workerów

Domyślnie (`mode: crew`) sesja główna zostaje na jednym modelu-orkiestratorze (domyślnie Sonnet). Przechodzi na niego raz, przy pierwszym prompcie, i potem już się nie zmienia, więc jej cache nie przepada. Pracę wymagającą kilku wywołań narzędzi wykonują trwałe workery: `worker-haiku` (szukanie, czytanie kodu, podsumowania, komendy), `worker-sonnet` (jasne funkcje, poprawki, testy) i `worker-opus` (trudne bugi, architektura, audyty).

Worker zachowuje kontekst między zadaniami: kolejne zadanie orkiestrator wysyła mu przez `SendMessage` (zakończony worker wznawia pracę z tym, co wie). Workery same wykonują zadanie (nie mogą uruchamiać agentów) i odsyłają raport do 10 linii zamiast całych plików. Orkiestrator ma zlecać pracę tylko wtedy, gdy zajmie ona co najmniej 3 wywołania narzędzi, bo przekazanie i raport kosztują go dwa jego własne zapytania. Podpowiedź „oddaj workerowi” dostaje tylko przy zadaniach trudniejszych niż jego model. Gdy model odpala drugiego workera tego samego typu, mod odmawia i wskazuje istniejącego, chyba że ten urósł albo ostygł na tyle, że nowy wyjdzie taniej. `!haiku …` / `!opus …` oddaje cały prompt workerowi, a `!fable …` idzie do `worker-opus`. `/router off` wyłącza crew w tej sesji.

Gdy Twój `/model` to inny poziom niż orkiestrator, każde zapytanie sesji głównej i tak idzie na orkiestratora, a etykieta modelu w aplikacji dalej pokazuje Twój `/model`. Notka pod odpowiedzią, panel i `/router` mówią to wprost: `Sonnet·medium (overrides your Haiku) · crew · …`, według zapytania, które naprawdę wyszło. `orchestrator: session` zostawia sesję główną na Twoim `/model`. Gdy crew kosztuje więcej niż Twój `/model`, widać `extra ≈$X vs your Haiku` zamiast ujemnej oszczędności, a `/router` pokazuje osobno sesję główną i workery.

Krótka odpowiedź (`tak rób`, `Tak, etap 5`, `ok`) idzie dalej do workera, któremu oddano ostatnie zadanie (`SendMessage`), zamiast być robiona od nowa przez orkiestratora. `/router log` zapisuje, czy orkiestrator posłuchał podpowiedzi (`handoff`, `followed` true/false, `via` spawn albo SendMessage). `crewJudge: true` wysyła do sędziego to, czego reguły nie rozpoznają. Z `promptTag` pod każdym Twoim promptem pojawia się mały wiersz `router: Sonnet·medium · crew` (plan przy wysłaniu, potem to, na czym tura naprawdę poszła), a ta sama etykieta stoi przy trybach w stopce promptu. Jest tylko rysowana: model czyta wyłącznie Twoje słowa.

Przetestowane na żywo: dwa zadania dla `worker-haiku` w jednej sesji uruchomiły jednego workera, drugie poszło przez `SendMessage`, a koszt Haiku wyniósł $0.0023.

## Komendy

| | |
|---|---|
`/router-help` to spis wszystkich komend z wyjaśnieniem, po co są. Krótkie komendy to aliasy tych samych handlerów — `/router why` i `/router-why` robią to samo.

| | |
|---|---|
| `/router` | aktualny model, oszczędności w sesji i łącznie, przełączenia i wstrzymania, kompresja |
| `/router-help` | spis wszystkich komend i po co ich używać |
| `/router-start` | sprawdza instalację i włącza routing z sensownymi domyślnymi |
| `/router-why` | po ludzku wyjaśnia ostatnią decyzję: regułę albo sędziego, tier i effort, których chciał, czy rachunek cache zatrzymał bieżący model i czy zasugerowano Ultracode |
| `/router-effort [auto\|task\|fixed]` | pokazuje politykę effortu; ustawia tryb w tej sesji |
| `/router-ultracode [suggest\|auto\|off]` | pokazuje lub ustawia przełącznik Ultracode w tej sesji |
| `/router-cache` | trafienia cache, odczyty/zapisy i ciepłe wpisy z wiekiem |
| `/router-budget [usd\|off]` | budżet sesji; ostrzega przy 80%, przy 100% może zejść o tier |
| `/router-compact [on\|off\|now]` | auto-kompakt sesji tanim modelem przy progu danego tieru |
| `/router-log` | ostatnie 50 decyzji jako JSON, do strojenia |
| `/router-panel` | otwórz panel na żywo |
| `/router-style terse\|adhd\|off` | styl odpowiedzi w tej sesji |
| `/router-off` · `/router-on` | wyłącz lub włącz routing w tej sesji |
| `/router-reset` | wyczyść sumy, wyuczone profile tur, wyuczone korekty i log decyzji |

Formy `/router <sub>` (`/router why`, `/router log`, `/router off`, `/router on`, `/router style …`, `/router effort …`, `/router ultracode …`, `/router cache`, `/router budget …`, `/router compact …`, `/router start`, `/router help`) też działają.

`/router-cache` pokazuje, czy cache jest ciepły i jak długo, więc niski hit rate albo seria zimnych startów jest widoczna, a nie zgadywana. `/router-budget` to budżet sesji liczony z list-price leadgera routera: przy 80% ostrzega, przy 100% `budgetAction: warn` tylko ostrzega, a `downgrade` schodzi o jeden tier w następnym zadaniu. Nie nadpisze wymuszonego `!tier`.

**Auto-kompakt** odpala się na końcu tury, w której kontekst przekroczył próg tieru (domyślnie Opus i Sonnet przy 400k, Haiku przy 600k tokenów). Podsumowanie pisze tani model (`haiku`; ręcznie też `/compact haiku <notatki>`), więc następne żądanie przeczyta krótkie podsumowanie zamiast ponownie opłacać cały transcript na drogim modelu. Kilka ostatnich wiadomości zostaje słowo w słowo, a nieudane podsumowanie zostawia transcript w spokoju — nigdy nie przepada na kompakt drogiem modelem.

Status line pokazuje każdą decyzję (`router: Sonnet·medium (rule .86) · saved ≈$0.41`), a nota pod odpowiedzią nazywa model i powód — i niesie oszczędności: dolary oraz, gdzie są realne, tokeny (wynik kompresji i kompaktu, `≈120k tok saved`; routing oszczędza dolary za token, nie same tokeny). Przy włączonym `promptTag` twoja wysłana wiadomość kończy się małą linią `*router: Opus·medium*` — planowany model i effort; `/router why` poda ostateczną decyzję, jeśli cache math coś przytrzymał.

`/router why` odpowiada na „dlaczego nadal Opus?" albo „dlaczego effort nie spadł?" — oddziela błędny odczyt zadania od rachunku cache. Każda decyzja trafia też do `~/.claude/model-router/decisions.json` (ostatnie 500, prompt skrócony do 280 znaków), więc zły wybór modelu albo effortu można skopiować do `tests/classify.test.ts` jako oznaczony przypadek.

Ustawienia (`mode`, `orchestrator`, `escalate`, `style`, `compress`, `useRtk`, `cacheTtl`, `judge`, `layaUrl`, `layaApiKey`, `enableFable`, effort per poziom, `effortMode`, `workerCacheTtl`, `budgetUsd`, `budgetAction`, `promptTag`, `compactAuto`, `compactModel`, progi kompaktu, `ultracode`, `adapt`, `showNote`) pojawiają się przy instalacji i w `/config`. Pełny opis w [README po angielsku](README.md#settings).

## find-mod

> Wersja 0.1, wczesna: logika przetestowana na danych testowych, bez sprawdzenia na żywym GitHubie. Zgłaszaj, co nie działa.

Wyszukiwarka modów na GitHubie. `/find-mod opis tego, czego potrzebujesz` szuka od razu; samo `/find-mod` każe Claude'owi ustalić potrzebę z kontekstu sesji i dopytać, jeśli nie jest pewny. Claude może też sam wywołać narzędzie `mcp__find-mod__search`.

Jak wybiera: opis → angielskie słowa kluczowe → GitHub Search (tematy `claude-mod`, `claude-code-mod`, `claude-code-plugin` oraz szersze zapytanie tekstowe, bez zarchiwizowanych repo) → ocena dopasowania 0–3 przez Haiku (bez wglądu w gwiazdki; bez modelu: dopasowanie słów kluczowych) → spośród pasujących (ocena ≥ 2) wygrywa ten z największą liczbą gwiazdek. Zwraca też do 4 alternatyw.

Bez tokenu GitHub dopuszcza 10 wyszukiwań na minutę; przy limicie mod mówi to wprost zamiast udawać brak wyników. Lista tematów jest na górze `find-mod/hooks/search.ts` (`TOPICS`), model w `find-mod/hooks/register.tsx` (`JUDGE`). Testy: `claude plugin test find-mod`.

### Instalacja i gwiazdka

- `/find-mod install owner/repo` (albo `owner/repo:plugin`, gdy repo ma kilka) pokazuje podgląd i niczego nie instaluje. Dopiero `... --yes` instaluje w dwóch krokach: `claude plugin marketplace add owner/repo`, potem `claude plugin install <plugin>@<marketplace> --yes`, gdzie `<marketplace>` to pole `name` z `.claude-plugin/marketplace.json` repozytorium (nie `owner/repo`). Repo musi mieć ten plik; bez niego mod mówi, że nie zainstaluje automatycznie.
- Gwiazdka dla autora (`gh api -X PUT user/starred/owner/repo`) zależy od ustawienia `autoStar`: `ask` (domyślnie) po instalacji tylko proponuje `/find-mod star owner/repo`, `always` daje ją sama po udanej instalacji, `never` nic nie robi. Bez zalogowanego `gh` mod podaje link do ręcznego oddania gwiazdki. Claude nie ma narzędzia do instalacji: instalujesz tylko Ty, własnym poleceniem.

### Instalacja

`/plugin marketplace add preisnerai/claude-mods`, potem `/plugin install find-mod@claude-mods` (albo `model-router@claude-mods`).

Żeby Twój mod był znajdowany: dodaj do repozytorium temat `claude-mod` i plik `.claude-plugin/marketplace.json`.

## Podziękowania

- [laya-router](https://github.com/marcreichel/laya-router), Marc Reichel (MIT): routing na klasyfikatorze, koszt zmiany modelu w trakcie sesji, pierwszeństwo `/model`, wykrywanie zapętlenia, log kalibracyjny i opisy poziomów dla laya-serve.
- [rtk](https://github.com/rtk-ai/rtk), rtk-ai: strategie kompresji wyjścia, zaimplementowane tu od nowa, i binarka wywoływana, gdy jest zainstalowana. Kod rtk nie jest dołączony.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd), Ayoub Ghriss (MIT): zasady stylu `adhd`.

## Licencja

[MIT](LICENSE)
