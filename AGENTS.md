# claude-mods

Marketplace i dwa mody do Claude Code: `model-router` (routing modeli, kompresja wyjścia, oszczędność tokenów) i `find-mod` (wyszukiwarka modów na GitHubie). Korzeń repo (git, remote `preisnerai/claude-mods`) to ten katalog. Repo ma osobne niezacommitowane zmiany modelu-routera na gałęzi `claude/model-router-1-12-1`; nie dotykaj ich przy pracy nad dokumentacją, a dokumentację commituj wyłącznie na osobnej gałęzi i dopiero po zgodzie właściciela.
Pełna dokumentacja dla następcy: `docs/00_INDEX.md` (przegląd, architektura, runbook, dostępy, mapa wizualna `docs/mapa_wizualna.html`). Nie zmieniaj kodu modów bez uruchomienia `claude plugin validate` i `claude plugin test` w katalogu modu.

## Dokumentacja (źródło prawdy)

- `docs/` opisuje ten projekt dla następcy. Nieaktualny dokument to błąd, nie drobiazg.
- Po zadaniu, które zmienia strukturę, zachowanie, zależności, konfigurację albo wdrożenie: uruchom `/doc-sync` (tryb SYNC).
- Przed zgłoszeniem "gotowe": `python "%USERPROFILE%\.claude\skills\doc-sync\docsync.py" check --root .` musi przejść bez DRYF i SEKRET.
- Dokumenty przepisuj, nie dopisuj na końcu. Sekcji `<!-- HUMAN -->` nie zmieniaj samodzielnie.
- Żadnych kluczy, haseł ani tokenów w dokumentach: tylko nazwy i miejsce przechowywania.

- Manifest `docs/docsync.json` mówi, który dokument opisuje które pliki (`covers`).
