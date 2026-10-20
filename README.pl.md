![model-router](.github/header.svg)

<p align="center"><a href="README.md">English</a> · <b>Polski</b></p>

**model-router** to mod do Claude Code, który obniża koszt sesji w trzech miejscach naraz:

| | Co robi | Gdzie oszczędza |
|---|---|---|
| 🔀 **Routing** | Każdy prompt idzie do Haiku, Sonneta albo Opusa, zależnie od tego, czego wymaga. Lokalne reguły po polsku i angielsku rozpoznają jasne prompty bez wywołania modelu; tylko niejasne trafiają do sędziego Haiku (ok. $0.0001 za prompt). | Mniej tokenów Opusa |
| 🧮 **Rachunek cache** | Zmiana modelu wyrzuca prompt cache: następne zapytanie czyta całą rozmowę od nowa po cenie zapisu. Przed każdą zmianą router wycenia turę na obu modelach przy Twoim rozmiarze kontekstu i stanie cache, i przełącza tylko wtedy, gdy to się opłaca. | Żadne przełączenie nie kosztuje więcej, niż oszczędza |
| 🗜️ **Kompresja** | Wyjście Basha kurczy się, zanim trafi do rozmowy, w stylu rtk: bez pasków postępu i zaliczonych testów, powtórzenia zwinięte w licznik, każdy błąd zachowany. Pełne wyjście zostaje na dysku (`~/.claude/model-router/tee/`, ostatnie 200). Z zainstalowanym [rtk](https://github.com/rtk-ai/rtk) komendy, które rtk zna, idą przez `rtk pipe`. | Mniej wejścia w każdym kolejnym zapytaniu |
| ✂️ **Krócej** | Jedna krótka sekcja promptu systemowego: bez wstępów, podsumowań i formułek na koniec, komendy w jednym wywołaniu, czytanie fragmentów plików. Tryb `adhd` zaczyna od następnej akcji, wg [i-have-adhd](https://github.com/ayghri/i-have-adhd). | Mniej tokenów wyjściowych, które kosztują 5× więcej niż wejściowe |

`/router` pokazuje, ile to wszystko zaoszczędziło, w dolarach, dla tej sesji i łącznie.

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
| 40 tys. tokenów | **zostaje na Opusie**: zmiana kosztuje $0.12 więcej | **przełącza**: oszczędza $0.023 |
| 100 tys. | **zostaje**: +$0.35 | **przełącza**: −$0.035 |
| 400 tys. | **zostaje**: +$1.49 | **przełącza**: −$0.092 |

Opus 5.5 i Sonnet 5.5 czytają cache po tej samej cenie $0.20/MTok, więc w środku sesji Sonnet oszczędza tylko na wyjściu, a zapis rozmowy do jego cache kosztuje więcej. Haiku jest 40× tańszy od Opusa na wejściu, więc zejście na niego opłaca się nawet z zapisem. Gdy cache modelu wygasł (godzina bezczynności), obie strony płacą za zapis i wygrywa tańszy model.

Trudniejsze zadania to kwestia jakości, nie pieniędzy: domyślnie router podnosi poziom, gdy prompt tego wymaga, i pokazuje koszt zmiany. Ustaw `escalate: suggest`, żeby router tylko podpowiadał w linii statusu.

## Jak prompt jest kierowany

1. Prefiks `!haiku`, `!sonnet`, `!opus` (lub `!fable`) wymusza model; prefiks jest usuwany z promptu.
2. Krótka kontynuacja („ok”, „dalej”, „zrób to”) zostaje na bieżącym modelu.
3. Lokalne reguły PL/EN (0 tokenów): tłumaczenie, literówka, zmiana nazwy → Haiku; nowa funkcja, test, refaktor → Sonnet; „dlaczego… nie działa”, wyciek pamięci, architektura, audyt bezpieczeństwa → Opus.
4. Niejasne prompty: opcjonalnie [laya-serve](https://github.com/NandhaKishorM/laya) lokalnie, potem sędzia Haiku.
5. Rachunek cache decyduje, czy przełączyć.

Dodatkowo: ręczny `/model` wyłącza routing do końca sesji (`/router on` przywraca); trzy nieudane lub identyczne wywołania narzędzi z rzędu podnoszą poziom; subagenci bez wskazanego modelu dostają tańszy poziom tury; skille (`/mój-skill`) są kierowane po rozwiniętej treści.

## Tryb crew: jeden orkiestrator, trzech ciepłych workerów

Ustaw `mode: crew`, a model w sesji nigdy się nie zmienia. Sesja główna zostaje na jednym modelu-orkiestratorze (domyślnie Sonnet), więc jej cache nie przepada, a pracę wykonują trwałe workery: `worker-haiku` (szukanie, czytanie kodu, podsumowania, komendy), `worker-sonnet` (jasne funkcje, poprawki, testy) i `worker-opus` (trudne bugi, architektura, audyty).

Każdy worker to teammate: po pierwszym zadaniu czeka bezczynnie z ciepłym cache, a orkiestrator wysyła mu kolejne zadania przez `SendMessage`. Workery odsyłają krótkie raporty zamiast całych plików, więc kontekst orkiestratora zostaje mały. Gdy model próbuje odpalić drugiego workera tego samego typu, mod odmawia i wskazuje ciepłego. `!haiku …` / `!opus …` oddaje cały prompt workerowi.

Przetestowane na żywo: dwa zadania dla `worker-haiku` w jednej sesji uruchomiły jednego workera, drugie poszło przez `SendMessage`, a koszt Haiku wyniósł $0.0023.

## Komendy

| | |
|---|---|
| `/router` | aktualny model, oszczędności w sesji i łącznie, przełączenia i wstrzymania, kompresja |
| `/router style terse\|adhd\|off` | styl odpowiedzi w tej sesji |
| `/router off` · `/router on` | wyłącz lub włącz routing w tej sesji |
| `/router log` | ostatnie 50 decyzji jako JSON, do strojenia |
| `/router reset` | wyczyść sumy, wyuczone profile tur i log |

Ustawienia (`mode`, `orchestrator`, `escalate`, `style`, `compress`, `useRtk`, `cacheTtl`, `judge`, `layaUrl`, `enableFable`, effort per poziom, `showNote`) pojawiają się przy instalacji i w `/config`. Pełny opis w [README po angielsku](README.md#settings).

## Podziękowania

- [laya-router](https://github.com/marcreichel/laya-router), Marc Reichel (MIT): routing na klasyfikatorze, koszt zmiany modelu w trakcie sesji, pierwszeństwo `/model`, wykrywanie zapętlenia, log kalibracyjny i opisy poziomów dla laya-serve.
- [rtk](https://github.com/rtk-ai/rtk), rtk-ai: strategie kompresji wyjścia, zaimplementowane tu od nowa, i binarka wywoływana, gdy jest zainstalowana. Kod rtk nie jest dołączony.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd), Ayoub Ghriss (MIT): zasady stylu `adhd`.

## Licencja

[MIT](LICENSE)
