// rtk-lite: the strategies of rtk (github.com/rtk-ai/rtk) for Bash output, in TypeScript, so they run
// with nothing installed. Drop what is provably noise, fold exact repeats into a count, keep every line that
// carries an error, and cut only what is saved whole on disk. Anything that may be data passes as it came.

/** Output shorter than this is left alone: the saving would not pay for the risk. */
export const MIN_CHARS = 1_200
const MAX_LINES = 250
const HEAD = 80
const TAIL = 100
const KEEP_MIDDLE = 200
const AFTER_SIGNAL = 2
const LINE_CAP = 500

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

// Output the model may quote back into an Edit, or reads as data: passed through verbatim.
// Listings and short notes (ls, find, echo, wc) are not here: they hold nothing an Edit would quote, and a cut
// of them is saved whole on disk. `npm test; echo "exit $?"` must still compress.
const VERBATIM_COMMAND = /^(cat|tac|head|tail|sed|awk|gawk|less|more|bat|nl|xxd|od|hexdump|jq|yq|base64|diff|cut|column|tr|strings|grep|egrep|fgrep|rg|ag|ack|printenv|cmp|patch)$/
const VERBATIM_LINE = [
  /^git\s+(show|diff|blame|cat-file|grep|format-patch|ls-files|ls-tree|config|remote|branch|tag|log\b.*(\s-p\b|\s--patch\b|\s--stat\b|\s--format|\s--pretty)|stash\s+show)/,
  /^gh\s+(pr|issue|run|api|release)\s+(diff|view|api|list)?/,
  /^(docker|podman|kubectl|oc)\s+(inspect|get|describe|logs|config)\b/,
  /^(curl|wget|http|xh)\b/,
  /^(npm|pnpm|yarn)\s+(view|info|ls|list|why|explain|config)\b/,
  /^(python3?|node|bun|deno|ruby|perl|php)\s+(-c|-e|--eval|-p)\b/,
  /^(sqlite3|psql|mysql)\b/,
]

const TEST =
  /\b(jest|vitest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|pest|ctest|cargo\s+(test|nextest)|go\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test|bun\s+test|deno\s+test|dotnet\s+test|mvn\b.*\btest|gradlew?\b.*\btest|mix\s+test|swift\s+test|claude\s+plugin\s+test)\b/
const INSTALL =
  /\b((npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade)|pip3?\s+install|uv\s+(pip|sync|add)|poetry\s+(install|add|update)|brew\s+(install|upgrade)|apt(-get)?\s+(install|upgrade)|cargo\s+(build|install|fetch|check)|go\s+(get|mod\s+download|build)|bundle\s+install|composer\s+(install|update|require)|docker\s+(pull|build|compose\s+(pull|build|up))|gem\s+install)\b/

export type Family = 'test' | 'install' | 'generic'

const WRAPPERS = /^((\w+=("[^"]*"|'[^']*'|\S*))\s+|(sudo(\s+-[uUgh]\s+\S+|\s+-\S+)*|time|env(\s+-\S+)*|command|exec|nice(\s+-n\s*\S+)?|nohup|stdbuf(\s+-\S+)*|unbuffer|timeout(\s+-\S+)*\s+\S+|xargs(\s+-\S+(\s+\S+)?)*|do|then|else|elif|!|\{|\()\s+)+/

/** One simple command as it runs: wrappers, keywords and the executable's directory gone, git's global options too. */
function normalize(segment: string): string {
  let s = segment.trim().replace(/^[({]\s*/, '').replace(WRAPPERS, '')
  s = s.replace(/^(\S*\/)(\S+)/, '$2')
  s = s.replace(/^git((\s+(-C\s+\S+|-c\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+|--paginate|-P))+)/, 'git')
  return s
}

/** The simple commands of a command line: `a && b | c`, the script of `bash -c '…'` and what `-exec`/`xargs` runs. */
export function segments(command: string): string[] {
  const inner = [...command.matchAll(/\b(?:ba|z|da)?sh\s+-c\s+(['"])([\s\S]*?)\1/g)].map(m => m[2] ?? '')
  const execs = [...command.matchAll(/\s-exec(?:dir)?\s+(.+?)(?:\;|\s\+|$)/g)].map(m => m[1] ?? '')
  return [command, ...inner, ...execs]
    .flatMap(c => c.split(/&&|\|\||[;|\n]|\$\(|`/))
    .map(normalize)
    .filter(s => s !== '' && !/^(for|while|until|if|fi|done|esac|case)\b/.test(s))
}

function isVerbatim(segment: string): boolean {
  const word = segment.split(/\s+/)[0] ?? ''
  return VERBATIM_COMMAND.test(word) || VERBATIM_LINE.some(p => p.test(segment))
}

/** Undefined when the output must reach the model verbatim. */
export function familyOf(command: string): Family | undefined {
  const parts = segments(command)
  if (parts.length === 0 || parts.some(isVerbatim)) {
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

// `rtk pipe -f <filter>` parses a command's own output. Only plain runs whose output rtk's parser expects:
// a mode that prints something else (a listing, a config, help) would be summarized as a false "all good".
const RTK_FILTERS: [RegExp, RegExp | undefined, string][] = [
  [/^cargo\s+test\b/, /\s(--list|--help|-h|--no-run|--doc)\b/, 'cargo-test'],
  [/^(python3?\s+-m\s+)?pytest\b/, /\s(--collect-only|--co|--fixtures|--markers|-h|--help|--version)\b/, 'pytest'],
  [/^((npx|bunx|pnpm\s+exec)\s+)?tsc\b/, /\s(--showConfig|--list\w*|--explain\w*|--trace\w*|-h|--help|-v|--version|--init|--build|-b)\b/, 'tsc'],
  [/^(python3?\s+-m\s+)?mypy\b/, /\s(-h|--help|--version)\b/, 'mypy'],
  [/^go\s+build\b/, undefined, 'go-build'],
]

/** The rtk filter for a single plain command, when there is one. */
export function rtkFilter(command: string): string | undefined {
  const parts = segments(command)
  const only = parts.length === 1 ? parts[0] : undefined
  return only === undefined ? undefined : RTK_FILTERS.find(([is, not]) => is.test(only) && (not === undefined || !not.test(` ${only}`)))?.[2]
}

// Lines that carry a failure, a warning or a result: never dropped, folded or cut.
export const SIGNAL = /error|fail|exception|panic|traceback|assert|warn|✗|✘|×|denied|not found|fatal|cannot|unable|missing|undefined|expected|coverage|-->|^\s*at\s|^\s*File "/i

/** A line that carries a signal, its own fold count aside (the `×` of `(×12)` is no failure mark). */
function isSignal(line: string): boolean {
  return SIGNAL.test(line.replace(/ {2}\(×\d+\)$/, ''))
}

/** True when an rtk summary keeps the failures the raw output shows. */
export function keepsSignal(raw: string, filtered: string): boolean {
  const failing = raw.split('\n').some(l => /error|fail|panic|traceback/i.test(l))
  return !failing || /error|fail|panic|traceback/i.test(filtered)
}

// Lines that say nothing the model needs, in any output: redrawn bars, spinners, transfer progress.
const NOISE = [
  /^\s*[⠁-⣿]\s/,
  /^\s*\d{1,3}(\.\d+)?%\s*[|[▕][#=>\-█▉▊▋▌▍▎▏░▒▓ ]{3,}/,
  /^\s*[[(|]?[#=>\-█░▒▓]{10,}[\])|]?\s*\d{1,3}(\.\d+)?%\s*(\S+\s*\/\s*\S+)?\s*$/,
  /^(remote: )?(Enumerating|Counting|Compressing|Receiving|Resolving|Writing) (objects|deltas):/,
  /^[0-9a-f]{12}: (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/,
]

// One passing test, in test output: counted, not shown. Suite headers stay, so later output keeps its place.
const PASSING = [
  /^\s*(✓|✔|√|☑)\s/,
  /^\s*ok\s+\d+\b/, // TAP
  /^ok\s+\S+\s+[\d.]+s\s*$/, // go test, a package with nothing more to say
  /^\s*---\s+PASS:/,
  /^\s*===\s+(RUN|PAUSE|CONT)\b/,
  /^test \S+ \.\.\. ok$/, // cargo
  /^\S+::\S+ PASSED\b/, // pytest -v
  /^\S+\.py \.+\s*(\[\s*\d+%\])?$/, // pytest dots
  /^\s*\.+\s*$/,
  /^\s*\[\s*OK\s*\]/,
  /^\s*Compiling \S+ v\d/, // cargo build noise before the tests
]

export type Compressed = {
  text: string
  /** Lines (or parts of lines) the reader no longer sees in any form; a repeat folded into a count is not one. */
  hidden: number
}

/** A line with its numbers and hashes blanked: in install and build logs, lines that differ only there fold. */
function shape(line: string): string {
  return line
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/gi, 'h')
    .replace(/\d+(\.\d+)*/g, '#')
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

  // 2. Noise, and passing tests. A line that carries a signal is never either.
  lines = lines.filter(l => {
    if (SIGNAL.test(l)) {
      return true
    }
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

  // 3. Repeats. An exact run becomes one line with a count (nothing lost). In install and build logs, a run of
  // lines that differ only in numbers keeps its ends; everywhere else such lines may be data, and stay.
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
    const s = shape(line)
    const folds = (l: string) => family === 'install' && l.trim() !== '' && !SIGNAL.test(l) && shape(l) === s
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

  // 4. Long lines, when there is more than one line and the line is no error; blank runs.
  if (lines.length > 1) {
    lines = lines.map(l => {
      if (l.length <= LINE_CAP || isSignal(l)) {
        return l
      }
      hidden++
      return `${l.slice(0, LINE_CAP)}… [+${l.length - LINE_CAP} chars]`
    })
  }
  lines = lines.filter((l, i, all) => !(l.trim() === '' && (all[i - 1] ?? '').trim() === ''))

  // 5. Still too long: the head, the tail, and every error line in between with the lines just after it
  // (its location, its code frame). Only with the whole output saved on disk.
  if (options.allowCut && lines.length > MAX_LINES) {
    const middle = lines.slice(HEAD, lines.length - TAIL)
    const keep = new Set<number>()
    middle.forEach((l, i) => {
      if (isSignal(l)) {
        for (let k = i; k <= Math.min(i + AFTER_SIGNAL, middle.length - 1); k++) keep.add(k)
      }
    })
    const kept = [...keep].sort((a, b) => a - b).slice(0, KEEP_MIDDLE)
    const dropped = middle.length - kept.length
    const shown: string[] = []
    let last = -1
    for (const k of kept) {
      if (k !== last + 1) shown.push('…')
      shown.push(middle[k] ?? '')
      last = k
    }
    if (last !== middle.length - 1) shown.push('…')
    hidden += dropped
    lines = [...lines.slice(0, HEAD), `… ${dropped} of ${middle.length} lines cut${keep.size > KEEP_MIDDLE ? ` (${keep.size - KEEP_MIDDLE} error lines among them)` : ''} …`, ...shown, ...lines.slice(-TAIL)]
  }

  if (passing > 0) {
    lines.push(`(${passing} passing test lines hidden)`)
    hidden += passing
  }

  const text = lines.join('\n').trim()
  return text.length > raw.length * 0.9 ? { text: raw, hidden: 0 } : { text, hidden }
}
