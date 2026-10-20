import { expect, test } from 'claude-code/testing'

import { MIN_CHARS, compress, familyOf, keepsSignal, rtkFilter, segments } from '../hooks/compress'

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
  // A note printed after the run does not make the run's output verbatim.
  expect(familyOf('npm test; echo "exit $?"')).toBe('test')
  expect(familyOf('for i in $(seq 1 400); do echo "step $i"; done')).toBe('generic')
  expect(familyOf('make build')).toBe('generic')
})

test('rtk takes only single commands it has a filter for', async () => {
  expect(rtkFilter('cargo test --workspace')).toBe('cargo-test')
  expect(rtkFilter('npx tsc --noEmit')).toBe('tsc')
  expect(rtkFilter('rg TODO src')).toBeUndefined()
  expect(rtkFilter('npx prettier --check .')).toBeUndefined()
  expect(rtkFilter('pytest -q')).toBe('pytest')
  expect(rtkFilter('pytest --collect-only -q')).toBeUndefined()
  expect(rtkFilter('npx tsc --showConfig')).toBeUndefined()
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
  expect(text).toContain('(300 passing test lines hidden)')
  // Suite headers stay, so output under a suite keeps its suite.
  expect(text).toContain('PASS src/a.test.ts')
  expect(text).not.toContain('formats date case 17')
  expect(hidden).toBe(300)
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

test('every way of reading a file, a diff or data through Bash passes verbatim', async () => {
  for (const command of [
    'git -C web diff locales/pl.json',
    'git --no-pager diff',
    'git -c core.pager=cat show HEAD',
    'git log -p -3',
    'git stash show -p',
    'gh pr diff 12',
    '/bin/cat x',
    '/usr/bin/head -50 x',
    "bash -c 'cat x'",
    '(cat x)',
    'ls src | xargs cat',
    "find . -name '*.json' -exec cat {} \;",
    'for f in src/*.ts; do cat "$f"; done',
    'sudo -u www cat /etc/app.conf',
    'FOO="a b" cat x',
    'grep -rn TODO src',
    'docker inspect api',
    'kubectl get pods -o yaml',
    'curl -s https://example.com/api/items',
    'npm view react --json',
    'node -e "console.log(process.env)"',
  ]) {
    expect({ command, family: familyOf(command) }).toEqual({ command, family: undefined })
  }
})

test('generic output never folds lines that only look alike: they may be data', async () => {
  const raw = Array.from({ length: 60 }, (_, i) => `  "KEY_${i}": "value number ${i} for the service",`).join('\n')
  expect(compress(raw, 'generic', { allowCut: true }).text).toBe(raw)
})

test('a coverage summary is a result, not a progress bar', async () => {
  const raw = `${'x\n'.repeat(700)}76.55% coverage, 208/270 lines covered, -2.10% change in coverage`
  expect(compress(raw, 'generic', { allowCut: true }).text).toContain('76.55% coverage')
  const go = `${Array.from({ length: 80 }, (_, i) => `ok  \tpkg/p${i}\t0.0${i % 10}s`).join('\n')}\nok  \tpkg/core\t0.12s\tcoverage: 52.3% of statements`
  const text = compress(go, 'test', { allowCut: true }).text
  expect(text).toContain('coverage: 52.3% of statements')
  expect(text).toContain('(80 passing test lines hidden)')
})

test('an output that is one long line is left whole; an error line is never cut short', async () => {
  const json = `{"items":[${Array.from({ length: 200 }, (_, i) => `{"id":${i},"name":"item ${i}"}`).join(',')}]}`
  expect(compress(json, 'generic', { allowCut: true }).text).toBe(json)
  const error = `src/app.ts(12,7): error TS2322: Type '{ ${Array.from({ length: 60 }, (_, i) => `field${i}: string`).join('; ')} }' is not assignable.`
  const raw = [error, ...Array.from({ length: 60 }, () => `noise ${'y'.repeat(600)}`)].join('\n')
  const { text, hidden } = compress(raw, 'generic', { allowCut: true })
  expect(text).toContain(error)
  expect(hidden).toBe(1) // the 60 noise lines fold into one (×60) line, cut once
})

test('a long output keeps every error line in the middle, with the lines that locate it', async () => {
  const raw: string[] = []
  for (let i = 0; i < 300; i++) {
    raw.push(`compiling unit ${i} ${'.'.repeat(i % 7)}`)
    if (i % 10 === 5) raw.push(`error[E0308]: mismatched types ${i}`, `  --> src/m${i}/mod.rs:${i}:9`, `   |`)
  }
  const { text } = compress(raw.join('\n'), 'generic', { allowCut: true })
  for (let i = 5; i < 300; i += 10) {
    expect(text).toContain(`error[E0308]: mismatched types ${i}`)
    expect(text).toContain(`--> src/m${i}/mod.rs:${i}:9`)
  }
})

test('an rtk summary that lost the failures is refused', async () => {
  expect(keepsSignal('FAILED tests/a.py::test_x - assert 1 == 2', 'Pytest: No tests collected')).toBe(false)
  expect(keepsSignal('FAILED tests/a.py::test_x - assert 1 == 2', 'pytest: 1 failed\n  test_x: assert 1 == 2')).toBe(true)
  expect(keepsSignal('collected 3 items\n3 passed', 'pytest: 3 passed')).toBe(true)
})
