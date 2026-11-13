# claude-mods: dostępy i systemy zewnętrzne (08)

Zasada: tu są NAZWY i MIEJSCA. Żadnych haseł, kluczy ani tokenów. Lista wynika z kodu i konfiguracji (`marketplace.json`, `plugin.json`, `test.yml`, `find-mod/hooks/install.ts`); dane o kontach zna tylko właściciel.

<!-- HUMAN -->
| System | Do czego | Konto / właściciel | Zastępca | Gdzie leży hasło/klucz | Odzyskiwanie | Zweryfikowano |
|---|---|---|---|---|---|---|
| GitHub: repozytorium `preisnerai/claude-mods` | kod, marketplace (`/plugin marketplace add preisnerai/claude-mods`), strona domowa modów | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA |
| GitHub Actions (`test.yml`) | walidacja i testy modów | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | brak sekretów w pliku workflow (`permissions: contents: read`) | nie dotyczy | DO UZUPEŁNIENIA |
| Konto GitHub `preisnerai` (autor w manifestach) | własność organizacji lub konta | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA |
| GitHub CLI `gh` na komputerze użytkownika | gwiazdka po instalacji w `find-mod` (`gh api -X PUT user/starred/...`) | konto użytkownika instalującego | nie dotyczy | sesja `gh` użytkownika | nie dotyczy | DO UZUPEŁNIENIA |
| Claude Code (CLI, aplikacja) i konto Anthropic użytkownika | silnik modów; wywołania Haiku (sąd, kompaktor) rozliczane na koncie użytkownika | konto użytkownika | nie dotyczy | nie dotyczy | nie dotyczy | DO UZUPEŁNIENIA |
| laya-serve (opcjonalny, `layaUrl`, `layaApiKey`) | lokalna klasyfikacja niejasnych promptów | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA przez właściciela | konfiguracja użytkownika modu (pole wrażliwe) | DO UZUPEŁNIENIA przez właściciela | DO UZUPEŁNIENIA |
| GitHub API (bez tokenu) | wyszukiwanie w `find-mod` | nie dotyczy | nie dotyczy | brak tokenu w kodzie (`find-mod/hooks/register.tsx`, nagłówki bez Authorization) | nie dotyczy | DO UZUPEŁNIENIA |
<!-- /HUMAN -->

## Co się stanie, gdy właściciel jest niedostępny

<!-- HUMAN -->
DO UZUPEŁNIENIA przez właściciela: kto ma prawa administratora do repozytorium i konta `preisnerai`, jak je uzyskać i kto zatwierdza wydania.
<!-- /HUMAN -->

## Fakty z kodu

- Mody nie zawierają kluczy API ani serwera; jedyne pole wrażliwe to `layaApiKey` w `model-router/.claude-plugin/plugin.json`.
- Lokalny stan modu (`~/.claude/model-router/`) zawiera historię użycia i zapis ostatnich decyzji; nie wysyła się go nigdzie z poziomu kodu (niezweryfikowane poza `register.tsx`).
- Sekretów nie wolno wpisywać do repo ani do `docs/`; `docsync check` zgłasza wzorce sekretów.
