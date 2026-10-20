import { expect, test } from 'claude-code/testing'

import { afterInstall, installMod, parseAutoStar, parseTarget, pickPlugin, previewText, readCatalog, starRepo } from './install'
import type { Get } from './search'

const MARKET = {
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
  expect(catalog.plugins.map(p => p.name)).toEqual(['token-saver', 'other'])

  expect('problem' in pickPlugin(catalog, t)).toBe(true)
  expect(pickPlugin(catalog, { ...t, plugin: 'other' })).toEqual({ name: 'other' })
  expect('problem' in pickPlugin(catalog, { ...t, plugin: 'nope' })).toBe(true)
  expect(pickPlugin({ plugins: [catalog.plugins[0]] }, t)).toEqual({ name: 'token-saver' })
})

test('a repo without marketplace.json says it cannot be installed automatically', async () => {
  const none = await readCatalog(async () => ({ status: 404, ok: false, text: '' }), t)
  expect('problem' in none && none.problem).toContain('marketplace.json')
})

test('the preview installs nothing and shows the confirmation command', () => {
  const text = previewText({ ...t, plugin: 'token-saver' }, { plugins: [{ name: 'token-saver', description: 'Saves tokens' }] }, 'token-saver')
  expect(text).toContain('/find-mod install top/mods:token-saver --yes')
  expect(text).toContain('przejrzyj repozytorium')
})

test('install runs claude with an argument vector, no shell', async () => {
  calls.length = 0
  const done = await installMod(runOk, t, 'token-saver')
  expect(done.ok).toBe(true)
  expect(calls[0]).toEqual(['claude', 'plugin', 'install', 'token-saver', '--marketplace', 'top/mods', '--json'])

  const failed = await installMod(async () => ({ exitCode: 1, stdout: '', stderr: 'Plugin "x" not found' }), t, 'x')
  expect(failed.ok).toBe(false)
  expect(failed.text).toContain('not found')
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
