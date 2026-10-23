# model-router — następne dodatki

**Kryterium sukcesu:** użytkownik traci mniej tokenów przy szybszej i skuteczniejszej pracy. Wszystko ma być proste i automatyczne, tak by nowa osoba umiała tego używać bez konfiguracji.

## Zasady dla każdego dodatku
1. Działa od razu po instalacji, bez ustawiania czegokolwiek (rozsądne wartości domyślne).
2. Nie powoduje przebudowania cache (system prompt nie zmienia się w trakcie sesji).
3. Ma testy w `tests/`; `claude plugin validate .` i `claude plugin test .` przechodzą.
4. Zero nowych zależności.
5. Test porównawczy: ta sama seria zadań na 1.4.0 i na nowej wersji, nowa zużywa mniej tokenów przy tej samej poprawności.

## Kolejność wdrożenia

### Etap 0 — trafność wyboru modelu (najpierw, bo od tego zależy reszta)
Diagnoza z `hooks/classify.ts`: reguły to pojedyncze słowa kluczowe nastawione na kod. Słowo „review", „debug" czy „fix" waży tyle samo bez względu na rozmiar zadania. Praca nie-kodowa (tłumaczenia w SPIM, Excel, Notion, Chrome, maile) prawie nie ma reguł, więc idzie do sądu Haiku albo zostaje na bieżącym modelu. Dochodzi cache math, który słusznie blokuje zejście z Opusa w środku sesji, ale z zewnątrz wygląda jak zły wybór.

**Status w 1.7.0:** wdrożone i połączone z effort/ultracode z 1.5.0. Korpus z etykietami i próg ≥85% jest w `tests/classify.test.ts`; reguły nie-kodowe, negacje, sygnały rozmiaru i polityka research → Sonnet (nigdy Opus) w `hooks/classify.ts`; `!+`/`!-`, wykrywanie niezadowolenia, `decisions.json` i `/router why` w `hooks/register.tsx`; wyjaśnienia w `hooks/why.ts`; etykiety Desktop (Extra, Max, Ultracode) i uczenie z `!+`/`!-` w `hooks/adapt.ts`. Brakuje jeszcze 2–3 prawdziwych promptów, na których router się pomylił — do dopisania do korpusu.

- **Zestaw testowy z prawdziwych promptów** (PL i EN, kod i nie-kod) z oczekiwanym tierem. Cel: zgodność ≥85% na zestawie, mierzona w `tests/classify.test.ts`.
- **Reguły dla pracy nie-kodowej i agentowej**: tłumaczenie/edycja tekstów, arkusze, maile, operacje w przeglądarce i przez API.
- **Sygnały zamiast samych słów**: liczba plików i załączników, błędy narzędzi w poprzedniej turze, długość i precyzja polecenia, negacje („nie refaktoruj"), kombinacje słów zamiast pojedynczych.
- **Sąd Haiku z kontekstem** ostatnich 2 tur i z progiem pewności; poniżej progu zostaje bieżący model.
- **Szybka korekta jednym znakiem**: `!+` (za słaby model, idź wyżej) i `!-` (za mocny, zejdź niżej) po decyzji routera. Każda korekta zasila uczenie z Etapu 3.
- **`/router why`**: po ludzku wyjaśnia ostatnią decyzję (reguła, sąd albo cache math) i mówi, kiedy „zły" wybór wynika z kosztu przebudowy cache.
- **Wykrywanie niezadowolenia**: „znowu źle", „popraw to", „nie o to chodziło" w prompcie uruchamia eskalację o jeden tier.

### Etap 1 — start dla nowych osób
**Status w 1.7.0:** `/router-start` i `/router-help` wdrożone; `/router-effort` i `/router-ultracode` dają szybką kontrolę. Profil i komunikaty w języku użytkownika nadal do zrobienia.
- **`/router start`**: sprawdza instalację, pokazuje w 3 liniach, co mod robi, włącza wszystko poprawnie.
- **Profil zamiast 15 ustawień**: `oszczędny | zrównoważony | jakość`. Reszta ustawień jako „zaawansowane".
- **Komunikaty po ludzku i w języku użytkownika** (`lang` wykrywany z promptów), np. „Przełączono na Sonnet, oszczędzasz ok. 0,40 $".
- **Podsumowanie na koniec sesji** w jednej linii: ile tokenów i dolarów zaoszczędzono.

### Etap 2 — oszczędności automatyczne
**Status w 1.8.0:** budżet sesji (`/router-budget`, `budgetUsd`, `budgetAction`), subagentowy TTL cache (`workerCacheTtl`) i auto-kompakt modelem Haiku (`/router-compact`, `compactAuto` + progi per tier; wzorzec z MIT modu `haiku-compact`) wdrożone. Kompresja poza Bash (Grep/Glob/WebFetch/WebSearch/MCP) nadal do zrobienia — research ostrzega, że sama kompresja tool outputu rzadko obniża billed cost, bo cache dominuje, więc najpierw mierzymy.
- **Kompresja poza Bash**: wyniki Grep/Glob, WebFetch/WebSearch i duże odpowiedzi MCP. Pełny zapis do `tee`, linie z błędem nigdy nie są wycinane. Cel: wyniki mniejsze o ≥40%.
- **Auto-sprzątanie workerów**: zimny lub rozdęty worker jest podmieniany na świeżego bez pytania. Cel: zimne wywołanie zawsze trafia do świeżego workera.
- **Auto-budżet z domyślnym limitem**: ostrzeżenie przy 80%, po przekroczeniu automatyczne przejście na tańszy tier. Cel: koszt sesji ≤ limit +5%.

### Etap 3 — mod się uczy
- **Uczenie się z korekt** (`!opus`, `/model` po decyzji routera): następne podobne prompty trafiają lepiej. Cel: −30% ręcznych korekt po 50 promptach.
- **Auto-wykrywanie projektu**: tryb `crew`/`route` dobierany po typie repo i historii, bez pliku konfiguracyjnego.

### Etap 4 — skrypty do powtarzalnej pracy (nowy pomysł)
Powtarzalna praca nie powinna za każdym razem przechodzić przez model. Skrypt wykonuje się za 0 tokenów.

- **Wykrywanie powtórek**: mod porównuje sekwencje wywołań narzędzi (z `/router log` i historii sesji). Gdy ta sama sekwencja (np. te same komendy Bash, ten sam wzorzec edycji) pojawia się ≥3 razy, uznaje ją za kandydata na skrypt.
- **Propozycja jednym zdaniem**: „Robisz to po raz 4. Zapisać jako skrypt `nazwa`? (oszczędność ≈ X tokenów za użycie)". Użytkownik odpowiada tak/nie, nic nie dzieje się bez zgody.
- **Generowanie skryptu**: tani worker (Haiku lub Sonnet) składa skrypt z zarejestrowanych kroków i zapisuje w `.claude/scripts/` (PowerShell na Windows, bash gdzie indziej), z parametrami zamiast wartości na sztywno.
- **Uruchamianie**: `/router run <nazwa>` albo automatycznie, gdy prompt pasuje do znanego skryptu („zrób to co zwykle…"). Wynik przechodzi przez kompresję jak każdy Bash.
- **Bezpieczeństwo**: skrypty tylko z komend, które użytkownik już wcześniej wykonał lub zatwierdził. Brak komend destrukcyjnych (usuwanie, push, wysyłka) bez potwierdzenia na etapie uruchomienia.
- **Zarządzanie**: `/router scripts` pokazuje listę, liczbę użyć i zaoszczędzone tokeny. Nieużywane skrypty znikają z listy po 90 dniach.
- **Kryteria sukcesu etapu**: zadanie powtórzone po zapisaniu skryptu zużywa ≥80% mniej tokenów; wynik jest taki sam jak przy ręcznym wykonaniu (test porównawczy); skrypt nigdy nie uruchamia się bez zgody przy komendach destrukcyjnych.

## Odrzucone / odłożone
Osobne profile per projekt w pliku (zastępuje je auto-wykrywanie), `/router explain`, eksport CSV (wartościowe dla twórców, nie dla nowych osób).
