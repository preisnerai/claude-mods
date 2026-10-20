// Instalacja moda znalezionego przez find-mod i gwiazdka dla autora.
//
// Zasady: nic nie instaluje się bez wyraźnego `--yes` wpisanego przez użytkownika, a przedtem
// widać podgląd (co za repo, jakie pluginy). Gwiazdka tylko po udanej instalacji i tylko zgodnie
// z ustawieniem autoStar: ask (domyślnie, pyta), always albo never.

import type { Get } from './search'

export type Target = { owner: string; repo: string; plugin?: string }

type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type Catalog = { plugins: { name: string; description: string }[] }

export type AutoStar = 'ask' | 'always' | 'never'

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// "owner/repo", "owner/repo:plugin" albo adres github.com. Tylko znaki bezpieczne dla argv i URL-a.
export function parseTarget(arg: string): Target | undefined {
  const m = arg.trim().match(/^(?:https?:\/\/github\.com\/)?([^/\s:]+)\/([^/\s:]+?)(?:\.git)?(?::([^\s:]+))?\/?$/)
  if (m === null) return undefined
  const [, owner, repo, plugin] = m
  if (![owner, repo].every(p => NAME.test(p) && !p.includes('..'))) return undefined
  if (plugin !== undefined && !NAME.test(plugin)) return undefined
  return { owner, repo, plugin }
}

export function parseAutoStar(value: unknown): AutoStar {
  return value === 'always' || value === 'never' ? value : 'ask'
}

// Katalog pluginów repo: jego .claude-plugin/marketplace.json (to z niego `plugin install` bierze nazwy).
export async function readCatalog(get: Get, t: Target): Promise<Catalog | { problem: string }> {
  const reply = await get(`https://raw.githubusercontent.com/${t.owner}/${t.repo}/HEAD/.claude-plugin/marketplace.json`).catch(
    () => undefined,
  )
  if (reply === undefined) return { problem: 'brak połączenia z GitHubem' }
  if (reply.status === 404) {
    return { problem: `${t.owner}/${t.repo} nie ma pliku .claude-plugin/marketplace.json, więc nie da się go zainstalować automatycznie` }
  }
  if (!reply.ok) return { problem: `GitHub odpowiedział statusem ${reply.status}` }
  try {
    const json = JSON.parse(reply.text) as { plugins?: unknown }
    const plugins = (Array.isArray(json.plugins) ? json.plugins : [])
      .map((p: Record<string, unknown>) => ({
        name: typeof p.name === 'string' ? p.name : '',
        description: typeof p.description === 'string' ? p.description : '',
      }))
      .filter(p => NAME.test(p.name))
    return plugins.length === 0 ? { problem: 'plik marketplace.json nie wymienia żadnego pluginu' } : { plugins }
  } catch {
    return { problem: 'plik marketplace.json nie jest poprawnym JSON-em' }
  }
}

// Który plugin instalować: wskazany po dwukropku albo jedyny w katalogu.
export function pickPlugin(catalog: Catalog, t: Target): { name: string } | { problem: string } {
  if (t.plugin !== undefined) {
    return catalog.plugins.some(p => p.name === t.plugin)
      ? { name: t.plugin }
      : { problem: `w ${t.owner}/${t.repo} nie ma pluginu „${t.plugin}” (są: ${catalog.plugins.map(p => p.name).join(', ')})` }
  }
  if (catalog.plugins.length === 1) return { name: catalog.plugins[0].name }
  return {
    problem: `w ${t.owner}/${t.repo} jest kilka pluginów, wskaż jeden: ${catalog.plugins.map(p => `/find-mod install ${t.owner}/${t.repo}:${p.name}`).join(' lub ')}`,
  }
}

export function previewText(t: Target, catalog: Catalog, name: string): string {
  const chosen = catalog.plugins.find(p => p.name === name)
  const spec = `${t.owner}/${t.repo}${t.plugin !== undefined ? `:${t.plugin}` : ''}`
  return [
    `Do instalacji: ${name} z https://github.com/${t.owner}/${t.repo}`,
    chosen?.description ? `   ${chosen.description.replace(/\s+/g, ' ').slice(0, 200)}` : '',
    '',
    'Mod to kod, który działa w Twojej sesji (hooki, komendy, narzędzia). Zanim go włączysz, przejrzyj repozytorium.',
    `Instalacja jest śledzona z gałęzi domyślnej repozytorium, więc późniejsze zmiany autora też do Ciebie trafią.`,
    `Zainstalować? /find-mod install ${spec} --yes`,
  ]
    .filter(l => l !== '')
    .join('\n')
}

export async function installMod(run: Run, t: Target, name: string): Promise<{ ok: boolean; text: string }> {
  const r = await run(['claude', 'plugin', 'install', name, '--marketplace', `${t.owner}/${t.repo}`, '--json']).catch(
    (err: unknown) => ({ exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : 'nie udało się uruchomić claude' }),
  )
  if (r.exitCode === 0) return { ok: true, text: `Zainstalowano ${name} (${t.owner}/${t.repo}).` }
  const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)
  return { ok: false, text: `Instalacja ${name} nie powiodła się${why === '' ? '' : `: ${why}`}.` }
}

// Gwiazdka przez `gh` użytkownika: to jego konto i jego zgoda. Gdy gh brak lub nie zalogowany, podajemy link.
export async function starRepo(run: Run, t: Target): Promise<{ ok: boolean; text: string }> {
  const r = await run(['gh', 'api', '-X', 'PUT', `user/starred/${t.owner}/${t.repo}`]).catch(() => undefined)
  if (r !== undefined && r.exitCode === 0) return { ok: true, text: `Zostawiono gwiazdkę: ${t.owner}/${t.repo}.` }
  return {
    ok: false,
    text: `Nie udało się dać gwiazdki automatycznie (potrzebne zalogowane \`gh\`). Zrobisz to ręcznie: https://github.com/${t.owner}/${t.repo}`,
  }
}

// Po udanej instalacji: zależnie od ustawienia gwiazdka od razu albo pytanie.
export async function afterInstall(run: Run, t: Target, mode: AutoStar): Promise<string> {
  if (mode === 'never') return ''
  if (mode === 'ask') {
    return `\nPodoba się? Zostaw autorowi gwiazdkę: /find-mod star ${t.owner}/${t.repo}\n(Ustawienie autoStar: ask / always / never.)`
  }
  const s = await starRepo(run, t)
  return `\n${s.text} (autoStar: always; wyłączysz w ustawieniach moda.)`
}
