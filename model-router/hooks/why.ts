import { effortLabel } from './adapt'

/** One entry of the calibration log: what the router decided and why. */
export type Entry = Record<string, unknown> & {
  at?: string
  event?: string
  tier?: string
  effort?: string | number | null
  effortWanted?: string | number | null
  effortNote?: string
  source?: string
  confidence?: number
  why?: string
  decision?: string
  taken?: boolean
  from?: string | null
  fromEffort?: string | number | null
  to?: string
  context?: number
  reason?: string
  worker?: string
  mode?: string
  prompt?: string
}

// Events that answer "why is the model what it is": the last one wins.
const DECISIONS = new Set(['route', 'unsure', 'judge', 'escalate', 'manual', 'fallback', 'delegate'])

function tierName(value: unknown): string {
  const text = String(value ?? '').trim()
  return text === '' ? 'the current model' : text[0]!.toUpperCase() + text.slice(1)
}

/** "Sonnet·medium"; the Desktop picker calls xhigh "Extra". */
function modelLine(tier: unknown, effort: unknown): string {
  const name = tierName(tier)
  return effort === undefined || effort === null || String(effort) === '' ? name : `${name}·${effortLabel(effort)}`
}

function when(entry: Entry): string {
  return typeof entry.at === 'string' && entry.at.length >= 16 ? ` at ${entry.at.slice(11, 16)} UTC` : ''
}

function promptLine(entry: Entry): string {
  if (typeof entry.prompt !== 'string') {
    return ''
  }
  const text = entry.prompt.replace(/\s+/g, ' ').trim()
  return text === '' ? '' : `\nPrompt: "${text.length > 140 ? `${text.slice(0, 137)}...` : text}"`
}

function cacheHint(decision: string): string {
  return decision.includes('cache')
    ? ' That is the cache math, not a misread of the task: a model or effort change re-writes the whole conversation into the new cache, which past a certain size costs more than the change saves.'
    : ''
}

/** The last entry that explains the current route, newest first. */
export function lastDecision(entries: unknown[]): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (typeof entry === 'object' && entry !== null && DECISIONS.has(String((entry as Entry).event))) {
      return entry as Entry
    }
  }
  return undefined
}

/** An Ultracode hint logged after the last route decision: it belongs to the same prompt. */
export function lastUltracodeAfter(entries: unknown[]): Entry | undefined {
  let decision = -1
  let ultracode = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const event = String((entry as Entry).event)
    if (decision === -1 && DECISIONS.has(event)) {
      decision = i
    }
    if (ultracode === -1 && event === 'ultracode') {
      ultracode = i
    }
  }
  return ultracode > decision ? (entries[ultracode] as Entry) : undefined
}

/** Turns the last decision into a few lines a person can act on. */
export function explainDecision(entry: Entry | undefined): string {
  if (entry === undefined) {
    return 'No routing decision recorded yet. Send a prompt first; `/router log` shows the raw entries.'
  }
  const at = when(entry)
  const label = String(entry.why ?? '').trim()
  const decision = String(entry.decision ?? '').trim()
  const prompt = promptLine(entry)
  const model = modelLine(entry.tier, entry.effort)
  switch (entry.event) {
    case 'route': {
      const source = String(entry.source ?? 'rule')
      if (entry.taken === false) {
        const wanted = modelLine(entry.tier, entry.effortWanted ?? entry.effort)
        const kept = modelLine(entry.from, entry.fromEffort ?? entry.effort)
        const reason = label === '' ? '' : ` (${label})`
        const main = `Last decision${at}: the task wanted ${wanted}${reason}, but the router stayed on ${kept}. ${decision}${cacheHint(decision)}`
        return `${main.replace(/\s+/g, ' ').trim()}${prompt}`
      }
      if (source === 'follow-up') {
        return `Last decision${at}: stayed on ${model} because this prompt continues the work in progress.${prompt}`
      }
      if (source === 'forced') {
        const why = label === '' || label === 'forced' ? 'forced by the prefix you typed' : `forced by the prefix you typed (${label})`
        return `Last decision${at}: ${model}, ${why}.${prompt}`
      }
      if (source === 'escalated') {
        return `Last decision${at}: escalated from ${modelLine(entry.from, entry.effort)} to ${model}${label === '' ? '' : ` (${label})`}.${prompt}`
      }
      if (source === 'crew') {
        return `Last decision${at}: stayed on ${model} — the orchestrator handles it.${prompt}`
      }
      const confidence = typeof entry.confidence === 'number' ? `, confidence ${entry.confidence.toFixed(2).replace(/^0/, '')}` : ''
      const moved = typeof entry.from === 'string' && entry.from !== entry.tier ? ` from ${modelLine(entry.from, entry.fromEffort)}` : ''
      const rule = label === '' || label === 'judge' ? '' : ` — ${label}`
      const tail = decision === '' || decision === label || decision === 'judge' ? '' : ` ${decision}`
      return `Last decision${at}: ${model} (${source}${confidence})${moved}${rule}.${tail}${prompt}`
    }
    case 'ultracode': {
      const mode = String(entry.mode ?? 'suggest')
      const why = label === '' ? '' : ` (${label})`
      return mode === 'auto'
        ? `Last decision${at}: ${model} ran as Ultracode — a multi-agent workflow, often done sooner and cheaper overall${why}.${prompt}`
        : `Last decision${at}: ${model} is a hard task; add 'ultracode' to run it as a multi-agent workflow${why}.${prompt}`
    }
    case 'unsure':
      return `Last decision${at}: stayed on ${model} because no local rule or judge was confident enough.${prompt}`
    case 'judge':
      return `The Haiku judge did not decide${at}: ${String(entry.reason ?? 'no answer')}${typeof entry.confidence === 'number' ? ` (confidence ${entry.confidence.toFixed(2)})` : ''}. The current model stayed.${prompt}`
    case 'escalate': {
      const suggested = entry.taken === false ? ' Suggested only; the model did not change.' : ''
      return `Last decision${at}: escalated from ${modelLine(entry.from, entry.effort)} to ${modelLine(entry.to, entry.effort)} because ${String(entry.reason ?? 'the tools kept failing')}.${suggested}`
    }
    case 'manual':
      return `Routing turned off${at}: /model was changed by hand to ${String(entry.to ?? 'another model')}. \`/router on\` resumes routing.`
    case 'fallback':
      return `The engine fell back${at} from ${String(entry.from ?? 'its model')} to ${String(entry.to ?? 'another model')}; routing pauses until the next prompt.`
    case 'delegate':
      return `Last decision${at}: crew mode handed a ${model} task to ${String(entry.worker ?? `${tierName(entry.tier)} worker`)}.${prompt}`
    default:
      return 'No routing decision recorded yet. Send a prompt first; `/router log` shows the raw entries.'
  }
}
