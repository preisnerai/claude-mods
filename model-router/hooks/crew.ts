import type { Tier, Warm } from '../types'
import { cacheKey, priceOf, turnCost } from './cost'
import type { Cache, Profile, Target } from './cost'

// Crew mode: the main session stays on one model (the orchestrator) so its prompt cache never resets, and work
// goes to long-lived workers, one per model. A worker idles between tasks with its own cache warm, takes the
// next task by message, and answers with a short report instead of its whole transcript.

export const WORKERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export function workerName(tier: Tier): string {
  return `worker-${tier}`
}

/** The full agent type, as the Agent tool and `agent.spawn` spell it. */
export function workerType(tier: Tier): string {
  return `model-router:${workerName(tier)}`
}

/** The worker tier of an agent type, however it was spelled (`worker-haiku`, `model-router:worker-haiku`). */
export function tierOfWorker(subagentType: string): Tier | undefined {
  return WORKERS.find(t => subagentType === workerType(t) || subagentType === workerName(t))
}

const WHEN: Record<Tier, string> = {
  haiku: 'mechanical work with a large input: searching and reading code, summarizing files or logs, running commands and reporting what they print, edits with exact instructions. Never debugging, design, security, decisions or reviews.',
  sonnet: 'a clear feature or fix across a few files, tests, a refactor with a clear target, scripts and queries.',
  opus: 'unclear failures to debug, architecture and design, security or performance analysis, multi-file refactors, plans.',
  fable: 'proofs, new theories, bounds.',
}

export function workerSpec(tier: Tier, model: string, effort: string) {
  return {
    name: workerName(tier),
    description: `Worker on ${tier}: ${WHEN[tier]} Long-lived: after its first task, send it the next one with SendMessage.`,
    prompt: WORKER_PROMPT,
    model,
    effort,
    // A worker does its task itself: no further hand-offs, no reports of reports.
    disallowedTools: ['Agent'],
  }
}

const WORKER_PROMPT = `You are a worker for an orchestrator model. Each message is one task: do it with your tools, then reply with a report.
- Read files yourself; never ask for content you can open. Do not start agents: do the work here.
- Report in at most 10 lines, starting with done, partial or blocked: what changed or what you found (path:line), the command that checks it, what is still open. Point to files, logs and diffs; never paste them.
- Say what you did not check or are unsure of; never guess a path, a line or a result.
- If the task is ambiguous or blocked, say in one line what is missing.
- Keep what you learned for the next task. Batch shell commands; read only the part of a file you need.`

export type CrewOptions = {
  /** A start_session tool is offered (Claude Desktop), or may be loaded with ToolSearch. */
  sessions?: boolean
  /** The model id a separate Haiku session is started on. */
  haikuModel?: string
}

/** The orchestrator's standing instructions: one section at the end of the main system prompt. */
export function crewSection(orchestrator: Tier, enabled: readonly Tier[], canMessage: boolean, opts: CrewOptions = {}): string {
  const rows = enabled.map(t => `- ${workerName(t)} (subagent_type "${workerType(t)}"): ${WHEN[t]}`).join('\n')
  const reuse = canMessage
    ? '- First task: the Agent tool with that subagent_type and name. Later tasks: SendMessage to the name. If the mod refuses a spawn, do what its message says.'
    : '- Start a worker with the Agent tool, with that subagent_type and name.'
  const sessions = opts.sessions === true
    ? `\n- A large job that is separate and independent of this conversation (bulk translation of files, a pass over many files): propose it with the start_session tool (load it with ToolSearch when it is deferred), never as a fork of this conversation: context "fresh", model "${opts.haikuModel ?? 'claude-haiku-5-5'}", a short brief in prompt (goal, files, what "done" means) and the background it needs. initiation "user_asked" only when the person asked for separate work; otherwise "own_initiative". Its result comes back here: check it as a worker's report. Never for debugging, design, security or decisions.`
    : ''
  return `# Crew (model-router)
You orchestrate on ${orchestrator} and stay on it: a model switch mid-conversation re-writes the whole conversation into another cache. Each of your requests re-reads this whole conversation, every tool result you read stays in it for every later request, and a delegation costs you two requests (the hand-off, then the report).
Do it yourself when it takes at most two tool calls or needs only this conversation: questions, decisions, short edits, translating or rewriting text given here.
Delegate when it takes three or more tool calls, many files or long command output:
${rows}
${reuse}
- Hand-off: goal, file paths with line ranges, constraints, what "done" means. Name files, never paste them: your output costs more than the worker's reads.
- Wait for the report; never read or poll a worker's output file. Check it before you build on it: confirm the claims your answer or next edit rests on (one targeted read or grep), above all a Haiku report; never redo the task.${sessions}
- Independent tasks for different workers go out in one message. Answer the user in a few lines without repeating the report.`
}

/**
 * A line the orchestrator reads beside a prompt that a worker should take. Forced (`!opus …`): hand it all over.
 * Otherwise a harder tier than the orchestrator's (quality), or a mechanical task for Haiku that the cost math
 * says is cheaper there (`handoffPays`).
 */
export function delegationHint(tier: Tier, isForced: boolean, live: string | undefined, why?: string): string {
  const name = workerName(tier)
  const how = live !== undefined ? `SendMessage to "${live}"` : `Agent tool, subagent_type "${workerType(tier)}", name "${name}"`
  if (isForced) {
    return `[model-router] The user chose ${tier} for this task: hand all of it to ${name} (${how}), then relay its report in a few lines.`
  }
  if (tier === 'haiku') {
    return `[model-router] Mechanical task${why === undefined || why === '' ? '' : ` (${why})`}: hand the reading and running to ${name} (${how}) with a brief (goal, files, what "done" means); keep any judgment for yourself, and check its report before you use it.`
  }
  return `[model-router] ${tier}-level task: if it takes three or more tool calls, hand it to ${name} (${how}); otherwise do it yourself.`
}

/**
 * A short follow-up ("tak rób", "Tak, etap 5") to the task last handed to a worker: it goes on with that worker,
 * whose context already holds the task, rather than being started over by the orchestrator.
 */
export function followUpHint(tier: Tier, live: string | undefined): string {
  const name = workerName(tier)
  const how = live !== undefined ? `SendMessage to "${live}"` : `Agent tool, subagent_type "${workerType(tier)}", name "${name}"`
  return `[model-router] Follow-up to the ${tier}-level task handed to ${name}: if ${name} did that work, send this on to it (${how}); otherwise do it yourself.`
}

/**
 * The person says the last answer missed ("znowu źle", "nie działa" right after the work): a stronger worker takes
 * it, told what was asked, what was done and what is still wrong.
 */
export function retryHint(tier: Tier, live: string | undefined): string {
  const name = workerName(tier)
  const how = live !== undefined ? `SendMessage to "${live}"` : `Agent tool, subagent_type "${workerType(tier)}", name "${name}"`
  return `[model-router] The user says the last answer missed: hand this to ${name} (${how}) with what was asked, what was done and what is still wrong, then check its result before you answer.`
}

// ---- when a hand-off to Haiku pays ----------------------------------------------------------------------------

/**
 * The expected shape of a mechanical task, by its rule: tool calls, what the answer writes, what each tool result
 * adds. Rules missing here are not mechanical (a question, a commit message, text given in the chat): the
 * orchestrator does them, a hand-off would only add two requests.
 */
export const MECHANICAL: Record<string, Profile> = {
  'code search': { steps: 5, output: 1_200, added: 5_000 },
  'run and report': { steps: 4, output: 1_000, added: 6_000 },
  'log scan': { steps: 3, output: 1_200, added: 10_000 },
  'read a file': { steps: 2, output: 800, added: 6_000 },
  summary: { steps: 3, output: 1_200, added: 8_000 },
  translation: { steps: 3, output: 4_000, added: 4_000 },
  rename: { steps: 5, output: 1_500, added: 3_000 },
  formatting: { steps: 4, output: 1_500, added: 3_000 },
  typo: { steps: 3, output: 800, added: 3_000 },
  'version bump': { steps: 3, output: 600, added: 2_000 },
}

// A summary or a translation is a tool task only when it names something to open; otherwise its text is here.
const NEEDS_FILES = new Set(['summary', 'translation'])
const FILEISH = /[\w./\\-]+\.[a-z]{1,5}\b|(?<![\p{L}])(files?|plik\p{L}*|folder\p{L}*|katalog\p{L}*|dir(ectory)?|repo\p{L}*|log\p{L}*|output|wynik\p{L}*|codebase|kod\p{L}*|src)(?![\p{L}])/iu
const WIDE = /(?<![\p{L}])(all|every|each|whole|entire|codebase|repo|wszystk\p{L}*|każd\p{L}*|kazd\p{L}*|cał\p{L}*|cal[yaeo]\p{L}*|całym|calym)(?![\p{L}])/iu
const TINY = /(?<![\p{L}])(quick|tiny|one[- ]?line|just one|single|jedn\p{L}* (linij\p{L}*|plik\p{L}*|miejsc\p{L}*)|tylko jed\p{L}*|szybk\p{L}*)(?![\p{L}])/iu

/**
 * The shape of the task a Haiku verdict names, or undefined when it is not a tool task worth a worker. Its
 * scope moves it: many files or "all / wszystkie" more steps, "one line / jeden plik" fewer.
 */
export function mechanicalProfile(labels: readonly string[], text: string): Profile | undefined {
  const label = labels.find(l => MECHANICAL[l] !== undefined && (!NEEDS_FILES.has(l) || FILEISH.test(text)))
  if (label === undefined) {
    return undefined
  }
  const base = MECHANICAL[label]!
  const files = new Set(text.match(/[\w./\\-]+\.[a-z]{1,5}\b/gi) ?? []).size
  let steps = base.steps + Math.max(0, files - 1)
  let added = base.added
  if (WIDE.test(text)) {
    steps *= 2
    added *= 1.5
  }
  if (TINY.test(text)) {
    steps = Math.max(1, Math.floor(steps / 2))
  }
  // Asked as a question ("where is X defined?"): one lookup, unless it says all of them.
  if (labels.includes('quick question') && !WIDE.test(text)) {
    steps = Math.min(steps, 2)
  }
  return { steps, output: base.output, added }
}

// What a hand-off adds around the worker's own work: the orchestrator's Agent call, the report it reads back,
// its relay, and what a fresh worker's first request writes (its system prompt and tool definitions).
export const HANDOFF = { call: 250, report: 600, relay: 300, workerPrefix: 12_000, later: 8 }

export type HandoffCase = {
  /** The orchestrator's model and effort, its context now and what its cache holds. */
  orchestrator: Target
  context: number
  warm: Warm
  now: number
  cache: Cache
  /** The worker's model and effort; its cache lifetime (subagents keep 5 minutes by default). */
  worker: Target
  workerCache: Cache
  /** A live worker of that model: its context and when its cache was last written. Absent: a cold start. */
  live?: { tokens: number; at: number }
  task: Profile
  /** Later orchestrator requests expected to re-read what this task leaves in the context. */
  later?: number
}

/**
 * The task done by the orchestrator against the same task handed to a worker, in dollars.
 *
 * Done here, every tool call re-reads the orchestrator's whole context and every tool result stays in it, read
 * again by each later request. Handed over, the orchestrator pays two short requests and keeps only the report,
 * and the worker pays its own (cold or warm) start. A small task in a small context stays here: two requests
 * and a worker's cold start cost more than it does.
 */
export function handoffCost(c: HandoffCase): { local: number; delegated: number } | undefined {
  const later = c.later ?? HANDOFF.later
  const orch = priceOf(c.orchestrator.model)
  if (orch === undefined) {
    return undefined
  }
  const local = turnCost(c.orchestrator.model, c.orchestrator.effort, c.context, c.warm, c.now, c.task, c.cache)
  const relay = turnCost(c.orchestrator.model, c.orchestrator.effort, c.context, c.warm, c.now, { steps: 2, output: HANDOFF.call + HANDOFF.relay, added: HANDOFF.report }, c.cache)
  const start = c.live?.tokens ?? HANDOFF.workerPrefix
  const key = cacheKey(c.worker.model, c.worker.effort)
  const workerWarm: Warm = c.live === undefined ? {} : { [key]: { tokens: c.live.tokens, at: c.live.at } }
  const work = turnCost(c.worker.model, c.worker.effort, start, workerWarm, c.now, c.task, c.workerCache)
  if (local === undefined || relay === undefined || work === undefined) {
    return undefined
  }
  // What stays in the orchestrator's context afterwards, re-read from cache by each later request.
  const carry = (tokens: number) => (later * tokens * orch.read) / 1e6
  return { local: local + carry(c.task.steps * c.task.added), delegated: relay + work + carry(HANDOFF.report) }
}

/**
 * True when handing the task over clearly pays: a task of at most two tool calls stays here (a hand-off is two
 * requests of its own, and a cold worker re-reads what the orchestrator may already hold), and otherwise the
 * hand-off must save a fifth of doing it and at least a cent: an estimate must clearly win to add a hop.
 */
export function handoffPays(c: HandoffCase, margin = 0.2, minUsd = 0.01): boolean {
  if (c.task.steps <= 2) {
    return false
  }
  const cost = handoffCost(c)
  return cost !== undefined && cost.delegated < cost.local * (1 - margin) && cost.local - cost.delegated >= minUsd
}
