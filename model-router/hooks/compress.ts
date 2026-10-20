// rtk-lite: the strategies of rtk (github.com/rtk-ai/rtk) for Bash output, in TypeScript, so they run
// with nothing installed. Filter noise, collapse repeats, keep every failure, and never return something
// longer than what came in. With the rtk binary on PATH, register.ts hands the commands rtk knows to `rtk pipe`.

/** Output shorter than this is left alone: the saving would not pay for the risk. */
export const MIN_CHARS = 1_200
const MAX_LINES = 250
const HEAD = 80
const TAIL = 100
const KEEP_MIDDLE = 40
const LINE_CAP = 500

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

// Output the model may quote back into an Edit, or already shaped by the person: passed through verbatim.
const VERBATIM = /^(cat|head|tail|sed|awk|less|more|bat|nl|xxd|od|hexdump|jq|yq|base64|diff|git\s+(show|diff|blame|cat-file))\b/

const TEST = /\b(jest|vitest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|pest|ctest|cargo\s+(test|nextest)|go\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test|bun\s+test|deno\s+test|dotnet\s+test|mvn\b.*\btest|gradlew?\b.*\btest|mix\s+test|swift\s+test|claude\s+plugin\s+test)\b/
const INSTALL =
  /\b((npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade)|pip3?\s+install|uv\s+(pip|sync|add)|poetry\s+(install|add|update)|brew\s+(install|upgrade)|apt(-get)?\s+(install|upgrade)|cargo\s+(build|install|fetch|check)|go\s+(get|mod\s+download|build)|bundle\s+install|composer\s+(install|update|require)|docker\s+(pull|build|compose\s+(pull|build|up))|gem\s+install)\b/

export type Family = 'test' | 'install' | 'generic'

/** The simple commands of a command line: `a && b | c` is a, b, c, each without `VAR=x`, `sudo`, `time`. */
export function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map(s => s.trim().replace(/^((\w+=\S*|sudo|time|env|command|exec|nice|nohup|timeout\s+\S+)\s+)+/, ''))
    .filter(s => s !== '')
}

/** Undefined when the output must reach the model verbatim. */
export function familyOf(command: string): Family | undefined {
  const parts = segments(command)
  if (parts.length === 0 || parts.some(s => VERBATIM.test(s))) {
    return undefined
  }
  if (parts.some(s => TEST.test(s))) {
    return 'test'
  }
  if (parts.some(s => INSTALL.test(s))) {
    return 'install'
  }
  return 'generic'
}

// `rtk pipe -f <filter>` reads output on stdin. Only filters that parse what the plain command prints.
const RTK_FILTERS: [RegExp, string][] = [
  [/^cargo\s+(test|nextest)\b/, 'cargo-test'],
  [/^(python3?\s+-m\s+)?pytest\b/, 'pytest'],
  [/^((npx|bunx|pnpm\s+exec)\s+)?tsc\b/, 'tsc'],
  [/^((npx|bunx|pnpm\s+exec)\s+)?vitest\b/, 'vitest'],
  [/^((python3?\s+-m\s+)?mypy)\b/, 'mypy'],
  [/^((npx|bunx)\s+)?prettier\b/, 'prettier'],
  [/^(vendor\/bin\/)?phpunit\b/, 'phpunit'],
  [/^ctest\b/, 'ctest'],
  [/^go\s+build\b/, 'go-build'],
  [/^(rg|grep)\b/, 'grep'],
  [/^(find|fd)\b/, 'find'],
]

/** The rtk filter for a single-command line, when there is one. */
export function rtkFilter(command: string): string | undefined {
  const parts = segments(command)
  const only = parts.length === 1 ? parts[0] : undefined
  return only === undefined ? undefined : RTK_FILTERS.find(([pattern]) => pattern.test(only))?.[1]
}

// Lines that say nothing the model needs, in any output.
const NOISE = [
  /^\s*[⠁-⣿]\s/, // spinners
  /^\s*\d{1,3}(\.\d+)?%\s*[|[▕█▉▊▋▌▍▎▏#=>\- ]/, // progress bars
  /^\s*[[(]?[#=>\-█░▒▓ ]{10,}[\])]?\s*\d{1,3}%/,
  /^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving|Writing) (objects|deltas):/,
  /^[0-9a-f]{12}: (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/,
]

// Lines that pass, in test output: counted, not shown.
const PASSING = [
  /^\s*(✓|✔|√|☑)\s/,
  /^\s*PASS(ED)?\b/,
  /^\s*ok\s+\d+\b/, // TAP
  /^ok\s+\S+\s+[\d.]+s/, // go test, per package
  /^\s*---\s+PASS:/,
  /^\s*===\s+(RUN|PAUSE|CONT)\b/,
  /^test \S+ \.\.\. ok$/, // cargo
  /^\S+::\S+ PASSED\b/, // pytest -v
  /^\S+\.py \.+\s*(\[\s*\d+%\])?$/, // pytest dots
  /^\s*\.+\s*$/, // dots
  /^\s*\[\s*OK\s*\]/,
  /^\s*Compiling \S+ v\d/, // cargo build noise before the tests
]

// Lines worth keeping from a middle that is cut.
const SIGNAL = /error|fail|exception|panic|traceback|assert|warn|✗|✘|×|denied|not found|fatal|cannot|unable|missing|undefined|expected/i

export type Compressed = {
  text: string
  /** Lines the reader no longer sees in any form (not counting repeats folded into a count). */
  hidden: number
}

/** A line with its numbers, hashes and quoted values blanked: lines that differ only there fold. */
function shape(line: string): string {
  return line
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/gi, 'h')
    .replace(/\d+(\.\d+)*/g, '#')
    .replace(/(['"`]).*?\1/g, 'q')
    .replace(/\s+/g, ' ')
}

/** Shrinks one Bash result. Returns the input unchanged when it would save under 10%. */
export function compress(raw: string, family: Family, options: { allowCut: boolean }): Compressed {
  if (raw.length < MIN_CHARS) {
    return { text: raw, hidden: 0 }
  }
  let hidden = 0
  let passing = 0

  // 1. Terminal control: colors gone, a redrawn line kept as its last state.
  let lines = raw
    .replace(ANSI, '')
    .split('\n')
    .map(l => (l.includes('\r') ? (l.split('\r').filter(s => s !== '').at(-1) ?? '') : l))

  // 2. Noise, and passing tests.
  lines = lines.filter(l => {
    if (NOISE.some(p => p.test(l))) {
      hidden++
      return false
    }
    if (family === 'test' && PASSING.some(p => p.test(l))) {
      passing++
      return false
    }
    return true
  })

  // 3. Repeats: an exact run becomes one line with a count, a run of one shape keeps its ends.
  const folded: string[] = []
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? ''
    let j = i + 1
    while (j < lines.length && lines[j] === line) j++
    if (j - i > 1) {
      folded.push(line.trim() === '' ? '' : `${line}  (×${j - i})`)
      i = j
      continue
    }
    // Lines that carry an error never fold into a count: every failure stays readable.
    const s = shape(line)
    const folds = (l: string) => l.trim() !== '' && !SIGNAL.test(l) && shape(l) === s
    while (j < lines.length && folds(line) && folds(lines[j] ?? '')) j++
    if (j - i >= 4) {
      folded.push(line, `  … ${j - i - 2} similar lines …`, lines[j - 1] ?? '')
      hidden += j - i - 2
    } else {
      folded.push(...lines.slice(i, j))
    }
    i = j
  }
  lines = folded

  // 4. Long lines, blank runs.
  lines = lines
    .map(l => (l.length > LINE_CAP ? `${l.slice(0, LINE_CAP)}… [+${l.length - LINE_CAP} chars]` : l))
    .filter((l, i, all) => !(l.trim() === '' && (all[i - 1] ?? '').trim() === ''))

  // 5. Still too long: keep the head, the tail, and the lines that carry errors in between.
  if (options.allowCut && lines.length > MAX_LINES) {
    const middle = lines.slice(HEAD, lines.length - TAIL)
    const kept = middle.filter(l => SIGNAL.test(l)).slice(0, KEEP_MIDDLE)
    hidden += middle.length - kept.length
    lines = [...lines.slice(0, HEAD), `… ${middle.length - kept.length} lines cut …`, ...kept, ...(kept.length > 0 ? ['…'] : []), ...lines.slice(-TAIL)]
  }

  if (passing > 0) {
    lines.push(`(${passing} passing test lines hidden)`)
    hidden += passing
  }

  const text = lines.join('\n').trim()
  return text.length > raw.length * 0.9 ? { text: raw, hidden: 0 } : { text, hidden }
}
