import { expect, test } from 'claude-code/testing'

import { MIN_CHARS, compress, familyOf, rtkFilter, segments } from '../hooks/compress'

test('commands are read segment by segment, without env, sudo or time', async () => {
  expect(segments('cd app && FOO=1 sudo npm test | tee out.log')).toEqual(['cd app', 'npm test', 'tee out.log'])
})

test('file contents and diffs pass verbatim; tests and installs get their own filters', async () => {
  expect(familyOf('cat src/index.ts')).toBeUndefined()
  expect(familyOf('git diff HEAD~1')).toBeUndefined()
  expect(familyOf('sed -n 1,80p README.md')).toBeUndefined()
  expect(familyOf('npm test -- --runInBand')).toBe('test')
  expect(familyOf('cd api && pytest -q')).toBe('test')
  expect(familyOf('pnpm install')).toBe('install')
  expect(familyOf('docker compose build')).toBe('install')
  expect(familyOf('ls -la')).toBe('generic')
})

test('rtk takes only single commands it has a filter for', async () => {
  expect(rtkFilter('cargo test --workspace')).toBe('cargo-test')
  expect(rtkFilter('npx tsc --noEmit')).toBe('tsc')
  expect(rtkFilter('rg TODO src')).toBe('grep')
  expect(rtkFilter('cargo test && echo done')).toBeUndefined()
  expect(rtkFilter('npm run build')).toBeUndefined()
})

test('short output is left alone', async () => {
  const out = 'ok\n'.repeat(10)
  expect(compress(out, 'test', { allowCut: true })).toEqual({ text: out, hidden: 0 })
})

test('passing tests are counted, every failure is kept', async () => {
  const passing = Array.from({ length: 300 }, (_, i) => `  ✓ formats date case ${i} (2 ms)`)
  const raw = [
    'PASS src/a.test.ts',
    ...passing,
    'FAIL src/b.test.ts',
    '  ● parses ISO weeks',
    '    expect(received).toBe(expected)',
    '    Expected: 53',
    '    Received: 52',
    'Tests: 1 failed, 300 passed, 301 total',
  ].join('\n')
  const { text, hidden } = compress(raw, 'test', { allowCut: true })
  expect(text).toContain('FAIL src/b.test.ts')
  expect(text).toContain('Received: 52')
  expect(text).toContain('Tests: 1 failed, 300 passed, 301 total')
  expect(text).toContain('(301 passing test lines hidden)')
  expect(text).not.toContain('formats date case 17')
  expect(hidden).toBe(301)
  expect(text.length < raw.length / 10).toBe(true)
})

test('progress bars, colors and redrawn lines go; repeats fold into a count', async () => {
  const raw = [
    '\x1b[32mInstalling dependencies\x1b[0m',
    ...Array.from({ length: 40 }, (_, i) => `${i * 2}% [${'#'.repeat(i)}${' '.repeat(40 - i)}]`),
    'downloading 10%\rdownloading 50%\rdownloading 100%',
    ...Array.from({ length: 30 }, () => 'npm WARN deprecated inflight@1.0.6: This module is not supported'),
    ...Array.from({ length: 30 }, (_, i) => `added package@1.${i}.0 from cache ${i}`),
    'added 912 packages in 14s',
  ].join('\n')
  const { text } = compress(raw, 'install', { allowCut: true })
  expect(text).not.toContain('\x1b[')
  expect(text).toContain('downloading 100%')
  expect(text).not.toContain('downloading 10%')
  expect(text).toContain('npm WARN deprecated inflight@1.0.6: This module is not supported  (×30)')
  expect(text).toContain('similar lines')
  expect(text).toContain('added 912 packages in 14s')
})

test('lines carrying errors never fold into a count', async () => {
  const errors = Array.from({ length: 40 }, (_, i) => `src/app.ts:${i + 1}:5 - error TS2322: Type 'string' is not assignable to type 'number'.`)
  const raw = [...errors, ...Array.from({ length: 40 }, (_, i) => `compiled module ${i} in ${i}ms`)].join('\n')
  const { text } = compress(raw, 'generic', { allowCut: true })
  for (const line of errors) {
    expect(text).toContain(line)
  }
})

test('a long output keeps its head, its tail and the errors in between', async () => {
  const raw = Array.from({ length: 2000 }, (_, i) => (i === 1000 ? 'Error: connection refused at db.ts:12' : `log line ${i} ${'x'.repeat((i * 7) % 13)} ${i % 3 === 0 ? 'alpha' : 'beta'} ${i}`)).join('\n')
  const cut = compress(raw, 'generic', { allowCut: true })
  expect(cut.text).toContain('Error: connection refused at db.ts:12')
  expect(cut.text).toContain('lines cut')
  expect(cut.hidden > 1000).toBe(true)
  const uncut = compress(raw, 'generic', { allowCut: false })
  expect(uncut.text).not.toContain('lines cut')
})

test('a listing of distinct files is never folded', async () => {
  const raw = Array.from({ length: 60 }, (_, i) => `-rw-r--r--  1 dev staff  ${1000 + i} Oct 20 09:15 ${['api', 'web', 'db', 'cli'][i % 4]}-${String.fromCharCode(97 + (i % 26))}${i}.ts`).join('\n')
  expect(compress(raw, 'generic', { allowCut: true }).text).toBe(raw)
})

test('output that would not shrink by 10% comes back unchanged', async () => {
  const raw = Array.from({ length: 100 }, (_, i) => `unique line number ${i} with distinct words ${'abcdefghij'.slice(i % 10)} ${i * 31}`).join('\n')
  expect(raw.length >= MIN_CHARS).toBe(true)
  expect(compress(raw, 'generic', { allowCut: true })).toEqual({ text: raw, hidden: 0 })
})
