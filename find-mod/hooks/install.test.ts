import { expect, test } from 'claude-code/testing'

import { afterInstall, installMod, parseAutoStar, parseTarget, pickPlugin, previewText, readCatalog, starRepo } from './install'
import type { Get } from './search'

const MARKET = {
  name: 'top-mods',
  plugins: [
    { name: 'token-saver', description: 'Saves tokens' },
    { name: 'other', description: 'Other' },
    { name: '../evil', description: 'bad name is dropped' },
  ],
}
const getOk: Get = async () => ({ status: 200, ok: true, text: JSON.stringify(MARKET) })
const t = { owner: 'top', repo: 'mods' }

const calls: (readonly string[])[] = []
const runOk = async (argv: readonly string[]) => {
  calls.push(argv)
  return { exitCode: 0, stdout: '', stderr: '' }
}

test('targets: owner/repo, :plugin, github url; anything unsafe is refused', () => {
  expect(parseTarget('top/mods')).toEqual({ owner: 'top', repo: 'mods', plugin: undefined })
  expect(parseTarget('top/mods:token-saver')).toEqual({ owner: 'top', repo: 'mods', plugin: 'token-saver' })
  expect(parseTarget('https://github.com/top/mods.git')).toEqual({ owner: 'top', repo: 'mods', plugin: undefined })
  for (const bad of ['top', '../x', 'a/b;rm -rf', '-x/y', 'a/b:../c', 'a/b/c']) expect(parseTarget(bad)).toBeUndefined()
})

test('the catalog drops unsafe plugin names and needs one plugin or a chosen one', async () => {
  const catalog = await readCatalog(getOk, t)
  if ('problem' in catalog) throw new Error(catalog.problem)
  expect(catalog.marketplace).toBe('top-mods')
  expect(catalog.plugins.map(p => p.name)).toEqual(['token-saver', 'other'])

  expect('problem' in pickPlugin(catalog, t)).toBe(true)
  expect(pickPlugin(catalog, { ...t, plugin: 'other' })).toEqual({ name: 'other' })
  expect('problem' in pickPlugin(catalog, { ...t, plugin: 'nope' })).toBe(true)
  expect(pickPlugin({ ...catalog, plugins: [catalog.plugins[0]] }, t)).toEqual({ name: 'token-saver' })
})

test('a repo without marketplace.json says it cannot be installed automatically', async () => {
  const none = await readCatalog(async () => ({ status: 404, ok: false, text: '' }), t)
  expect('problem' in none && none.problem).toContain('marketplace.json')
})

test('a marketplace.json without a usable name is refused', async () => {
  const nameless = await readCatalog(async () => ({ status: 200, ok: true, text: JSON.stringify({ plugins: MARKET.plugins }) }), t)
  expect('problem' in nameless && nameless.problem).toContain('name')
})

test('the preview installs nothing and shows the confirmation command', () => {
  const text = previewText({ ...t, plugin: 'token-saver' }, { marketplace: 'top-mods', plugins: [{ name: 'token-saver', description: 'Saves tokens' }] }, 'token-saver')
  expect(text).toContain('/find-mod install top/mods:token-saver --yes')
  expect(text).toContain('przejrzyj repozytorium')
})

test('install adds the marketplace, then installs plugin@marketplace, as argument vectors, no shell', async () => {
  calls.length = 0
  const done = await installMod(runOk, t, 'token-saver', 'top-mods')
  expect(done.ok).toBe(true)
  expect(calls).toEqual([
    ['claude', 'plugin', 'marketplace', 'add', 'top/mods'],
    ['claude', 'plugin', 'install', 'token-saver@top-mods', '--yes'],
  ])

  const failed = await installMod(
    async argv => ({ exitCode: argv[2] === 'install' ? 1 : 0, stdout: '', stderr: 'Plugin "x" not found' }),
    t,
    'x',
    'top-mods',
  )
  expect(failed.ok).toBe(false)
  expect(failed.text).toContain('not found')

  calls.length = 0
  const noMarket = await installMod(
    async argv => (calls.push(argv), { exitCode: 1, stdout: '', stderr: 'Failed to clone' }),
    t,
    'x',
    'top-mods',
  )
  expect(noMarket.ok).toBe(false)
  expect(noMarket.text).toContain('Failed to clone')
  expect(calls).toHaveLength(1)
})

test('the star follows autoStar: ask only proposes, never only stays silent, always stars', async () => {
  calls.length = 0
  expect(await afterInstall(runOk, t, 'never')).toBe('')
  expect(calls).toHaveLength(0)

  expect(await afterInstall(runOk, t, 'ask')).toContain('/find-mod star top/mods')
  expect(calls).toHaveLength(0)

  expect(await afterInstall(runOk, t, 'always')).toContain('Zostawiono gwiazdkę')
  expect(calls[0]).toEqual(['gh', 'api', '-X', 'PUT', 'user/starred/top/mods'])
})

test('without gh the star falls back to a link, and the setting defaults to ask', async () => {
  const s = await starRepo(async () => ({ exitCode: 127, stdout: '', stderr: 'gh: not found' }), t)
  expect(s.ok).toBe(false)
  expect(s.text).toContain('https://github.com/top/mods')

  expect(parseAutoStar(undefined)).toBe('ask')
  expect(parseAutoStar('bogus')).toBe('ask')
  expect(parseAutoStar('always')).toBe('always')
})
