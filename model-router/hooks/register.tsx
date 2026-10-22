import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, Register } from 'claude-code'

import type { Effort, Ledger, Route, Sent, Style, Tier } from '../types'
import { EFFORTS, ULTRACODE, categoryOf, clampEffort, effortFor, effortLabel, isHardest, learnedLine, nudge, shiftOf, shiftTier } from './adapt'
import type { Bias } from './adapt'
import {
  ORDER,
  heuristic,
  isDissatisfied,
  isFollowUp,
  layaQuestion,
  nextTier,
  parseJudgeVerdict,
  parseLaya,
  prevTier,
  rank,
  rubric,
  words,
} from './classify'
import type { Verdict } from './classify'
import { MIN_CHARS, compress, familyOf, keepsSignal, rtkFilter } from './compress'
import { CACHE, PROFILE, addLedger, cacheKey, cachedOf, canonical, dollars, emptyLedger, learn, promptOf, requestCost, saved, size, switchDelta, turnCost, usd } from './cost'
import type { Cache, LedgerDelta, Profile, Target } from './cost'
import { WORKERS, crewSection, delegationHint, tierOfWorker, workerName, workerSpec, workerType } from './crew'
import { STYLE, isStyle } from './style'
import { explainDecision, lastDecision, lastUltracodeAfter } from './why'

// Model per tier. Change the ids here to re-route.
const MODEL: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
const PANE = 'model-router'
const NAME: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

// Every command the mod registers. `/router-help` is the directory; the rest are short aliases.
const COMMANDS = [
  { name: 'router', description: 'model-router: stats, route, savings; `/router help` lists every command' },
  { name: 'router-help', description: 'model-router: list every command and explain what it is for' },
  { name: 'router-start', description: 'model-router: check the install and turn routing on' },
  { name: 'router-why', description: 'model-router: explain the last model/effort decision' },
  { name: 'router-effort', description: 'model-router: show or set effort mode (auto|task|fixed)' },
  { name: 'router-ultracode', description: 'model-router: Ultracode mode (suggest|auto|off)' },
  { name: 'router-log', description: 'model-router: last 50 raw decisions as JSON' },
  { name: 'router-panel', description: 'model-router: open the live pane' },
  { name: 'router-style', description: 'model-router: answer style (terse|adhd|off)' },
  { name: 'router-off', description: 'model-router: stop routing for this session' },
  { name: 'router-on', description: 'model-router: resume routing for this session' },
  { name: 'router-reset', description: 'model-router: clear totals, learned profiles, corrections and log' },
]

const HELP = [
  'model-router — commands',
  '',
  '  /router                    Show the current route, savings, switches/holds and compression.',
  '  /router-help               Show this list: every command and what it is for.',
  '  /router-start              Check the install and turn routing on with sane defaults.',
  '  /router-why                Explain the last model/effort decision, including cache and Ultracode.',
  '  /router-effort [mode]      Show the effort policy; set auto, task or fixed for this session.',
  '  /router-ultracode [mode]   Show or set Ultracode: suggest, auto or off.',
  '  /router-log                Show the last 50 raw decisions as JSON, for calibration.',
  '  /router-panel              Open the live pane.',
  '  /router-style [style]      Show or set the answer style: terse, adhd or off.',
  '  /router-off                Stop routing for this session.',
  '  /router-on                 Resume routing for this session.',
  '  /router-reset              Clear totals, learned profiles, corrections and the decision log.',
  '',
  'The same commands as /router subcommands:',
  '  /router help               Same as /router-help.',
  '  /router start              Same as /router-start.',
  '  /router why                Same as /router-why.',
  '  /router effort [mode]      Same as /router-effort.',
  '  /router ultracode [mode]   Same as /router-ultracode.',
  '  /router log                Same as /router-log.',
  '  /router panel              Same as /router-panel.',
  '  /router style [style]      Same as /router-style.',
  '  /router off                Same as /router-off.',
  '  /router on                 Same as /router-on.',
  '  /router reset              Same as /router-reset.',
  '',
  'Prompt prefixes:',
  '  !haiku !sonnet !opus !fable   Force a tier for this prompt.',
  '  !+ / !-                       Move one tier up or down from the current route.',
  '',
  'Effort: Desktop calls xhigh "Extra". The router never sends Max or Ultracode as an',
  'effort; Ultracode is a separate multi-agent switch for the hardest tasks.',
].join('\n')
const EFFORT: Record<Tier, Effort> = { haiku: 'low', sonnet: 'medium', opus: 'high', fable: 'xhigh' }
// Every Desktop effort, `max` and `ultracode` included, to read which way a person's /effort moved.
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

// Hand override for one prompt: "!opus przeprojektuj ten moduł".
const FORCE = /^!(haiku|sonnet|opus|fable)\s+/i
// One-character correction: "!+" one tier harder, "!-" one tier cheaper, relative to the current route.
const NUDGE = /^!([+-])\s*/i

// Failed or repeated tool calls in a row before the router escalates (or suggests it).
const STRIKES = 3
// A judge answer below this confidence is not a decision: the current model stays.
const JUDGE_FLOOR = 0.55
const LAYA_TIMEOUT_MS = 4_000
const LOG_CAP = 500
const TEE_SLOTS = 200
const QUEUE_CAP = 10

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const sessionModel = atom({ plugin: 'model-router', key: 'sessionModel' } as const, null)
const isManual = atom({ plugin: 'model-router', key: 'isManual' } as const, false)
const queued = atom({ plugin: 'model-router', key: 'queued' } as const, [])
const context = atom({ plugin: 'model-router', key: 'context' } as const, 0)
const prefix = atom({ plugin: 'model-router', key: 'prefix' } as const, 0)
const warm = atom({ plugin: 'model-router', key: 'warm' } as const, {})
const lastSent = atom({ plugin: 'model-router', key: 'lastSent' } as const, null)
const baseEffort = atom({ plugin: 'model-router', key: 'baseEffort' } as const, null)
const shadow = atom({ plugin: 'model-router', key: 'shadow' } as const, null)
const taskTier = atom({ plugin: 'model-router', key: 'taskTier' } as const, null)
const steps = atom({ plugin: 'model-router', key: 'steps' } as const, 0)
const turnFirst = atom({ plugin: 'model-router', key: 'turnFirst' } as const, 0)
const turnLast = atom({ plugin: 'model-router', key: 'turnLast' } as const, 0)
const strikes = atom({ plugin: 'model-router', key: 'strikes' } as const, 0)
const lastCall = atom({ plugin: 'model-router', key: 'lastCall' } as const, null)
const hasEscalated = atom({ plugin: 'model-router', key: 'hasEscalated' } as const, false)
const style = atom({ plugin: 'model-router', key: 'style' } as const, null)
const ledger = atom({ plugin: 'model-router', key: 'ledger' } as const, emptyLedger())
const workers = atom({ plugin: 'model-router', key: 'workers' } as const, [])
const workerWarm = atom({ plugin: 'model-router', key: 'workerWarm' } as const, {})
const paneAsked = atom({ plugin: 'model-router', key: 'paneAsked' } as const, false)
const note = atom({ plugin: 'model-router', key: 'note' } as const, null)
const category = atom({ plugin: 'model-router', key: 'category' } as const, null)

type $ = EngineInterface

type Prefix = { text: string; forced: Tier | null; nudge: -1 | 0 | 1; raw: string }

/** Reads "!opus …", "!+ …" and "!- …"; the text without its prefix goes to the model. */
function parsePrefix(text: string): Prefix {
  const force = FORCE.exec(text)
  if (force !== null) {
    return { text: text.slice(force[0].length), forced: force[1]!.toLowerCase() as Tier, nudge: 0, raw: force[0] }
  }
  const nudge = NUDGE.exec(text)
  if (nudge !== null) {
    return { text: text.slice(nudge[0].length), forced: null, nudge: nudge[1] === '+' ? 1 : -1, raw: nudge[0] }
  }
  return { text, forced: null, nudge: 0, raw: '' }
}

// What an agent of the crew may be doing and still take a message: a finished one resumes with its context.
const LIVE = new Set<AgentStatus>(['pending', 'running', 'waiting', 'idle', 'completed'])

type Config = {
  mode: 'route' | 'crew'
  orchestrator: Tier
  cache: Cache
  effort: Record<Tier, Effort>
  effortMode: 'auto' | 'fixed' | 'task'
  ultracode: 'suggest' | 'auto' | 'off'
  adapt: boolean
  enableFable: boolean
  escalate: 'auto' | 'suggest'
  judge: 'haiku' | 'off'
  style: Style
  compress: boolean
  useRtk: boolean
  showNote: boolean
  layaUrl: string
  layaHeaders: Record<string, string>
}

function flag(value: unknown, fallback: boolean): boolean {
  return value === undefined || value === '' ? fallback : String(value) === 'true'
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback
}

/** The tier a model id belongs to. */
function tierOf(model: string): Tier | undefined {
  const id = canonical(model)
  return ORDER.find(t => id.includes(t))
}

function describe(r: Route): string {
  const how = r.source === 'rule' || r.source === 'judge' || r.source === 'laya' ? `${r.source} ${r.confidence.toFixed(2).replace(/^0/, '')}` : r.source
  return `${NAME[r.tier]}·${effortLabel(r.effort)} (${how})`
}

// Every read-modify-write of the store, one after another: two hooks running at once (the main loop and a
// worker) would otherwise both read the old value and one of their writes would be lost.
let storeQueue: Promise<unknown> = Promise.resolve()

function storeUpdate<T>($: $, key: string, fn: (value: T | undefined) => T): Promise<void> {
  const run = storeQueue.then(async () => {
    await $.store.set(key, fn((await $.store.get(key)) as T | undefined))
  })
  storeQueue = run.catch(() => {})
  return run
}

// Calibration data: what was routed and why, read back with /router log and /router why.
async function log($: $, event: string, data: Record<string, unknown>) {
  try {
    const entry = { at: new Date(await $.clock.now()).toISOString(), event, ...data }
    let entries: unknown[] = []
    await storeUpdate<unknown[]>($, 'log', old => {
      entries = [...(old ?? []), entry].slice(-LOG_CAP)
      return entries
    })
    await writeLog($, entries)
  } catch {}
}

let basePromise: Promise<string> | undefined

/** The Claude config folder: where tee and the decision log live. */
function configBase($: $): Promise<string> {
  basePromise ??= (async () => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
    return (config ?? (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? '/tmp').replace(/\\/g, '/').replace(/\/+$/, '')
  })()
  return basePromise
}

/** A mirror of the in-memory log, so decisions can be inspected and used as calibration data. */
async function writeLog($: $, entries: unknown[]) {
  try {
    const base = await configBase($)
    await $.fs.write(`${base}/model-router/decisions.json`, JSON.stringify(entries, null, 2))
  } catch {}
}

/** Adds to this session's ledger and to the one kept across sessions. */
async function bill($: $, delta: LedgerDelta) {
  await update($, ledger, l => addLedger(l, delta))
  try {
    await storeUpdate<Ledger>($, 'ledger', all => addLedger({ ...emptyLedger(), ...all }, delta))
  } catch {}
}

async function profiles($: $): Promise<Record<Tier, Profile>> {
  try {
    const stored = ((await $.store.get('profile')) ?? {}) as Partial<Record<Tier, Partial<Profile>>>
    return Object.fromEntries(ORDER.map(t => [t, { ...PROFILE[t], ...stored[t] }])) as Record<Tier, Profile>
  } catch {
    return PROFILE
  }
}

// The route part of the last status line, so a hint can be added to it rather than replace it.
let lastStatus = ''

async function status($: $, text: string) {
  lastStatus = text
  const l = await read($, ledger)
  const money = l.routedSteps > 0 ? ` · saved ≈${dollars(saved(l))}` : ''
  $.ui.status(`router: ${text}${money}`)
}

/**
 * What a request on `tier` is sent with. The session's own tier keeps the session's model id and effort, so
 * routing back to it changes nothing about the request and its cache.
 */
async function targetFor($: $, tier: Tier, cfg: Config): Promise<Target> {
  const session = await read($, sessionModel)
  if (session !== null && tierOf(session) === tier) {
    return { model: session, effort: (await read($, baseEffort)) ?? undefined }
  }
  return { model: MODEL[tier], effort: cfg.effort[tier] }
}

// laya-serve classifies on your machine, for no tokens; its own wait is raced, since a prompt must not hang on it.
async function askLaya($: $, text: string, cfg: Config): Promise<Verdict | undefined> {
  try {
    const timer = new AbortController()
    const timeout = $.clock.sleep(LAYA_TIMEOUT_MS, { signal: timer.signal }).then(() => undefined)
    const request = $.http
      .fetch(`${cfg.layaUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cfg.layaHeaders },
        body: JSON.stringify({ state: text.slice(0, 4000), model: 'jev-latest', questions: { route: layaQuestion(cfg.enableFable) } }),
      })
      .then(r => (r.ok ? parseLaya(r.text) : undefined))
    const answer = await Promise.race([request, timeout]).finally(() => timer.abort())
    // Its confidence is the top probability, so the floor is 1/tiers: laya-router's calibrated thresholds.
    if (answer?.tier === undefined || answer.confidence < (cfg.enableFable ? 0.375 : 0.475)) {
      return undefined
    }
    return { tier: answer.tier, confidence: answer.confidence, source: 'laya', why: 'laya-serve' }
  } catch {
    return undefined
  }
}

async function askJudge($: $, text: string, cfg: Config): Promise<Verdict | undefined> {
  const rows = await $.session.messages()
  const previous = rows.slice(-2).map(r => `${r.role}: ${r.text.slice(0, 400)}`).join('\n') || '(none)'
  const reply = await $.model.complete({
    model: MODEL.haiku,
    system: rubric(cfg.enableFable),
    prompt: `<previous>\n${previous}\n</previous>\n\n<request>\n${text.slice(0, 4000)}\n</request>`,
    // Room for Haiku's adaptive thinking before its one word; only what it writes is paid for.
    maxTokens: 1_024,
    effort: 'low',
    timeoutMs: 8_000,
  })
  await bill($, { judgeCalls: 1, judgeUsd: usd(MODEL.haiku, reply.usage) ?? 0 })
  const parsed = reply.isAnswered ? parseJudgeVerdict(reply.text, cfg.enableFable) : undefined
  const prompt = text.slice(0, 280)
  if (!reply.isAnswered) {
    await log($, 'judge', { reason: reply.reason, prompt })
  } else if (parsed === undefined) {
    await log($, 'judge', { reason: 'unparsed', prompt })
  } else if (parsed.confidence < JUDGE_FLOOR) {
    await log($, 'judge', { reason: 'low-confidence', tier: parsed.tier, confidence: Number(parsed.confidence.toFixed(2)), prompt })
  }
  return parsed === undefined || parsed.confidence < JUDGE_FLOOR
    ? undefined
    : { tier: parsed.tier, confidence: parsed.confidence, source: 'judge', why: 'judge' }
}

/** Local rules first (no tokens, no wait); laya-serve or the Haiku judge only for what they cannot call. */
async function classify($: $, text: string, cfg: Config): Promise<Verdict | undefined> {
  const local = heuristic(text, cfg.enableFable, { failedTools: await read($, strikes) })
  if (local !== undefined) {
    return local
  }
  const laya = cfg.layaUrl === '' ? undefined : await askLaya($, text, cfg)
  if (laya !== undefined || cfg.judge === 'off') {
    return laya
  }
  try {
    return await askJudge($, text, cfg)
  } catch {
    return undefined
  }
}

async function recordSessionModel($: $) {
  if ((await read($, sessionModel)) === null) {
    const model = await $.session.model()
    await update($, sessionModel, () => model)
  }
}

/**
 * Moves the main loop to the verdict's tier when that is worth it.
 *
 * A model switch re-writes the whole conversation into the new model's cache, so a cheaper tier is taken only
 * when the turn it saves on outweighs that write. A harder tier is about quality, not money: `escalate: auto`
 * takes it, `suggest` names it in the status line and leaves the switch to the person.
 */
async function apply($: $, given: Verdict, cfg: Config, prompt?: string): Promise<Verdict> {
  await recordSessionModel($)
  const now = await $.clock.now()
  const isForced = given.source === 'forced'
  // What this person's corrections taught for this kind of task: a tier and an effort shift.
  const learned = cfg.adapt && !isForced ? shiftOf(await biasOf($), categoryOf(given), now) : { tier: 0, effort: 0 }
  const tier = shiftTier(given.tier, learned.tier, cfg.enableFable)
  const verdict = tier === given.tier ? given : { ...given, tier, why: `${given.why}, learned ${learned.tier > 0 ? '+' : ''}${learned.tier} tier` }
  await update($, category, () => (isForced ? null : categoryOf(given)))
  await update($, taskTier, () => verdict.tier)
  const session = (await read($, sessionModel)) ?? MODEL[verdict.tier]
  const sent = await read($, lastSent)
  const from: Target = sent === null ? { model: session, effort: (await read($, baseEffort)) ?? undefined } : { model: sent.model, effort: sent.effort ?? undefined }
  const fromTier = tierOf(from.model)
  const tokens = await read($, context)
  const profile = (await profiles($))[verdict.tier]
  const warmNow = await read($, warm)

  // The effort this task needs. The cache belongs to model and effort, so a new effort on the same model throws
  // it away like a switch does: it is taken only when the same math says it costs nothing more.
  const kept = await targetFor($, verdict.tier, cfg)
  // A manually chosen Ultracode is the person's own call: the router keeps it and only routes the model.
  const manualUltracode = String(from.effort ?? '').toLowerCase() === 'ultracode'
  const wanted = cfg.effortMode !== 'fixed' && !isForced && !manualUltracode
    ? effortFor(verdict, cfg.effort[verdict.tier], learned.effort)
    : kept.effort
  // Priced against what the cache holds now: when the last request went out at another effort on this same
  // model (an earlier task's own effort), staying there is an option too, so dropping back is never free by default.
  const stay = canonical(from.model) === canonical(kept.model) && from.effort !== kept.effort ? { model: kept.model, effort: from.effort } : undefined
  const costOf = (t: Target) => (tokens > 0 ? turnCost(t.model, t.effort, tokens, warmNow, now, profile, cfg.cache) : 0)
  let to: Target = kept
  if (stay !== undefined) {
    const a = costOf(kept)
    const b = costOf(stay)
    if (a !== undefined && b !== undefined && b < a) {
      to = stay
    }
  }
  if (wanted !== to.effort) {
    const candidate = { model: kept.model, effort: wanted }
    const extra = cfg.effortMode === 'task' ? 0 : tokens > 0 ? switchDelta(to, candidate, tokens, warmNow, now, profile, cfg.cache) : 0
    if (extra !== undefined && extra <= 0) {
      to = candidate
    }
  }
  const isOwnTier = tierOf(session) === verdict.tier && canonical(kept.model) === canonical(session)
  const target: Route = {
    tier: verdict.tier,
    model: MODEL[verdict.tier],
    effort: clampEffort(to.effort, cfg.effort[verdict.tier]),
    source: verdict.source,
    confidence: verdict.confidence,
    ...(isOwnTier && to.effort !== kept.effort ? { setsEffort: true } : {}),
  }

  let take = true
  let why = verdict.why
  if (!isForced && fromTier !== undefined && fromTier !== verdict.tier) {
    const isHarder = rank(verdict.tier) > rank(fromTier)
    const delta = tokens > 0 ? switchDelta(from, to, tokens, warmNow, now, profile, cfg.cache) : undefined
    if (isHarder) {
      take = cfg.escalate === 'auto'
      const cost = delta === undefined ? '' : ` (+${dollars(delta)} with the cache re-write of ${size(tokens)} tokens)`
      why = take ? `${verdict.why}${cost}` : `consider !${verdict.tier}${cost}`
    } else if (delta !== undefined) {
      take = delta < 0
      why = take
        ? `saves ≈${dollars(-delta)}`
        : `switching costs ${dollars(delta)} more (cache re-write of ${size(tokens)} tokens)`
    }
    if (tokens > 0) {
      await bill($, take ? { switches: 1 } : { holds: 1 })
    }
  }
  const effortNote = cfg.effortMode !== 'fixed' && !isForced && take && wanted !== kept.effort
    ? to.effort === wanted
      ? `effort ${effortLabel(wanted)} for this task`
      : `task wanted ${effortLabel(wanted)}, kept ${effortLabel(to.effort)} (cache)`
    : ''
  if (effortNote !== '') {
    why = `${why} · ${effortNote}`
  }
  await log($, 'route', {
    tier: verdict.tier,
    effort: to.effort ?? null,
    effortWanted: wanted,
    effortNote,
    source: verdict.source,
    confidence: Number(verdict.confidence.toFixed(2)),
    why: verdict.why,
    decision: why,
    taken: take,
    from: fromTier ?? null,
    fromEffort: from.effort ?? null,
    context: tokens,
    prompt: prompt?.slice(0, 280),
  })

  if (take) {
    await update($, route, () => target)
    await update($, note, () => `model-router: ${NAME[target.tier]} · ${why}`)
    await status($, `${describe({ ...target, effort: (to.effort as Effort | undefined) ?? target.effort })}${why === verdict.why ? '' : ' · ' + why}`)
  } else {
    const current = await read($, route)
    const name = fromTier === undefined ? from.model : NAME[fromTier]
    await update($, note, () => `model-router: stayed on ${name} · ${verdict.tier} task, ${why}`)
    await status($, `${current === null ? name : describe(current)} · ${verdict.tier} task, ${why}`)
  }
  return verdict
}

/** Crew mode: the main loop stays on the orchestrator for the whole session, so its cache is never thrown away. */
async function pinOrchestrator($: $, cfg: Config) {
  const t = cfg.orchestrator
  if ((await read($, route))?.source !== 'crew') {
    await recordSessionModel($)
    await update($, route, () => ({ tier: t, model: MODEL[t], effort: cfg.effort[t], source: 'crew', confidence: 1 }))
  }
}

async function baseTier($: $, cfg: Config): Promise<Tier> {
  const current = await read($, route)
  if (current !== null) {
    return current.tier
  }
  return cfg.mode === 'crew' ? cfg.orchestrator : tierOf(await $.session.model()) ?? cfg.orchestrator
}

async function routePrompt($: $, text: string, cfg: Config): Promise<Verdict | undefined> {
  const current = await read($, route)
  if (isDissatisfied(text)) {
    const base = await baseTier($, cfg)
    const up = nextTier(base, cfg.enableFable)
    const tokens = await read($, context)
    const effort = current?.effort ?? ((await read($, baseEffort)) as Effort | null) ?? null
    if (up === undefined) {
      const message = `already at ${NAME[base]}, the strongest tier`
      await update($, note, () => `model-router: ${message} · dissatisfaction`)
      await status($, `${message} · dissatisfaction`)
      await log($, 'route', {
        tier: base,
        effort,
        source: 'escalated',
        confidence: 1,
        why: 'dissatisfied',
        decision: message,
        taken: false,
        from: base,
        context: tokens,
        prompt: text.slice(0, 280),
      })
      return undefined
    }
    return apply($, { tier: up, confidence: 1, source: 'escalated', why: 'dissatisfied' }, cfg, text)
  }
  if (current !== null && isFollowUp(text, cfg.enableFable)) {
    await log($, 'route', {
      tier: current.tier,
      effort: current.effort,
      source: 'follow-up',
      confidence: 1,
      why: 'follow-up',
      decision: 'keeps the current model',
      taken: true,
      from: current.tier,
      context: await read($, context),
      prompt: text.slice(0, 280),
    })
    await update($, note, () => `model-router: ${NAME[current.tier]} · follow-up`)
    await status($, `${describe({ ...current, source: 'follow-up' })}`)
    return undefined
  }
  // "hi" says too little to route: the session's /model answers it, and the next prompt routes.
  if (current === null && words(text) < 3) {
    await log($, 'unsure', {
      tier: tierOf(await $.session.model()) ?? null,
      effort: (await read($, baseEffort)) ?? null,
      why: 'too short to route',
      decision: 'the session model answers',
      taken: false,
      context: await read($, context),
      prompt: text.slice(0, 280),
    })
    return undefined
  }
  const verdict = await classify($, text, cfg)
  if (verdict === undefined) {
    await log($, 'unsure', {
      tier: current?.tier ?? tierOf(await $.session.model()) ?? null,
      effort: current?.effort ?? ((await read($, baseEffort)) as Effort | null) ?? null,
      why: 'no confident rule or judge',
      decision: 'kept the current model',
      taken: false,
      context: await read($, context),
      prompt: text.slice(0, 280),
    })
    await status($, current === null ? 'unsure, using /model' : `${describe(current)} · unsure, kept`)
    return undefined
  }
  return apply($, verdict, cfg, text)
}

/** Routes one prompt as it enters: a forced tier, or the classifier's. Returns the text without its prefix. */
async function enter($: $, text: string, forcedTier: Tier | null, cfg: Config, forcedWhy = 'forced', nudge = 0): Promise<Verdict | undefined> {
  await update($, note, () => null)
  if (forcedTier === null) {
    return routePrompt($, text, cfg)
  }
  // A !tier or !+/!- over what the rules would pick is a correction, learned for that kind of task.
  const ruled = heuristic(text, cfg.enableFable, { failedTools: await read($, strikes) })
  if (nudge !== 0) {
    await correct($, cfg, await read($, category), 'tier', nudge)
  } else if (ruled !== undefined && ruled.tier !== forcedTier) {
    await correct($, cfg, categoryOf(ruled), 'tier', rank(forcedTier) - rank(ruled.tier))
  }
  await apply($, { tier: forcedTier, confidence: 1, source: 'forced', why: forcedWhy }, cfg, text)
  return undefined
}

/**
 * The hardest tasks may run as a multi-agent workflow: dearer per turn, often sooner done and cheaper overall.
 * `suggest` says so in the status line; `auto` adds the keyword to the prompt itself.
 */
async function ultracode($: $, text: string, verdict: Verdict | undefined, cfg: Config): Promise<string> {
  if (cfg.ultracode === 'off' || verdict === undefined || !isHardest(verdict) || ULTRACODE.test(text)) {
    return text
  }
  const chosen = await read($, route)
  await log($, 'ultracode', { mode: cfg.ultracode, tier: verdict.tier, effort: chosen?.effort ?? null, why: verdict.why })
  if (cfg.ultracode === 'auto') {
    await update($, note, n => `${n ?? 'model-router:'} · ran as ultracode`)
    return `${text.trimEnd()}\n\nultracode`
  }
  await status($, `${lastStatus === '' ? '' : `${lastStatus} · `}hard task: add 'ultracode' to run it as a multi-agent workflow`)
  return text
}

async function biasOf($: $): Promise<Bias | undefined> {
  try {
    return (await $.store.get('adapt')) as Bias | undefined
  } catch {
    return undefined
  }
}

/** One correction by the person (or by failing tools), learned across sessions for that kind of task. */
async function correct($: $, cfg: Config, cat: string | null, field: 'tier' | 'effort', delta: number) {
  if (!cfg.adapt || cat === null || delta === 0) {
    return
  }
  try {
    const now = await $.clock.now()
    await storeUpdate<Bias>($, 'adapt', b => nudge(b ?? {}, cat, field, delta, now))
    await log($, 'learn', { category: cat, field, delta: Math.sign(delta) })
  } catch {}
}

/** The worker of this tier that can take a message, the most recent one first. */
async function liveWorker($: $, tier: Tier): Promise<AgentInfo | undefined> {
  return (await $.agent.list()).filter(a => tierOfWorker(a.type) === tier && LIVE.has(a.status)).at(-1)
}

/** Where a message to this worker goes: a running agent by its name, a finished one by its id (it resumes). */
function addressOf(a: AgentInfo): string {
  return a.status === 'completed' ? a.id : (a.name ?? a.id)
}

/**
 * Crew mode: a prompt that needs another model reaches the orchestrator with a hint to hand it over. Forced
 * (`!opus …`): always, unless the orchestrator is that model already. Otherwise only for a harder tier than
 * the orchestrator's: below it, a hand-off and a report cost more than doing the task.
 */
async function delegation($: $, text: string, forcedTier: Tier | null, cfg: Config): Promise<string | undefined> {
  await update($, note, () => null)
  await pinOrchestrator($, cfg)
  const orchestrates = `crew · ${NAME[cfg.orchestrator]} orchestrates`
  // There is no Fable worker: a forced !fable goes to the strongest worker there is, and says so.
  const asked = forcedTier ?? heuristic(text, false, { failedTools: await read($, strikes) })?.tier
  const tier = asked === 'fable' ? 'opus' : asked
  const wanted = tier !== undefined && tier !== cfg.orchestrator && (forcedTier !== null || rank(tier) > rank(cfg.orchestrator))
  if (tier === undefined || !wanted) {
    await log($, 'route', {
      tier: cfg.orchestrator,
      effort: cfg.effort[cfg.orchestrator],
      source: 'crew',
      confidence: 1,
      why: tier === undefined ? 'no clear tier' : `${tier} task, orchestrator handles it`,
      decision: 'stays with the orchestrator',
      taken: true,
      from: cfg.orchestrator,
      context: await read($, context),
      prompt: text.slice(0, 280),
    })
    await status($, orchestrates)
    return undefined
  }
  const live = await liveWorker($, tier)
  const swap = asked === 'fable' ? ' (no Fable worker: the strongest one takes it)' : ''
  await update($, note, () => `model-router: crew · ${workerName(tier)}${swap}`)
  await status($, `${orchestrates} · ${tier} task → ${workerName(tier)}${swap}`)
  await log($, 'delegate', { tier, forced: forcedTier !== null, worker: workerName(tier), prompt: text.slice(0, 280) })
  return delegationHint(tier, forcedTier !== null, live === undefined ? undefined : addressOf(live))
}

// Agent calls the crew check refused: their errors are the mod's answer, not a struggling model.
const denied = new Set<string>()

function deny(toolUseId: string, reason: string) {
  denied.add(toolUseId)
  if (denied.size > 200) {
    denied.delete(denied.values().next().value ?? '')
  }
  return { deny: reason }
}

/**
 * Whether the next task is cheaper on this worker than on a fresh one: a worker with a warm, small context
 * wins; one whose cache lapsed, or whose context has grown far past a fresh worker's, loses.
 */
async function reuseIsCheaper($: $, agentId: string, tier: Tier, cfg: Config): Promise<boolean> {
  const state = (await read($, workerWarm))[agentId]
  if (state === undefined) {
    return true
  }
  const now = await $.clock.now()
  const profile = (await profiles($))[tier]
  const key = cacheKey(MODEL[tier], cfg.effort[tier])
  const reuse = turnCost(MODEL[tier], cfg.effort[tier], state.tokens, { [key]: { tokens: state.tokens, at: state.at } }, now, profile, cfg.cache)
  const fresh = turnCost(MODEL[tier], cfg.effort[tier], state.first, {}, now, profile, cfg.cache)
  return reuse === undefined || fresh === undefined || reuse <= fresh
}

/** Every cache entry cut down to what a fresh conversation still shares with the old one: the system prompt and tools. */
async function shrinkCaches($: $, keep: number) {
  await update($, warm, w => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, { ...v, tokens: Math.min(v.tokens, keep) }])))
  await update($, shadow, s => (s === null ? null : { ...s, tokens: Math.min(s.tokens, keep) }))
}

// Bash commands by tool_use_id, so their results can be compressed by what ran. Lost on reload: harmless.
const commands = new Map<string, string>()

function remember(id: string, command: string) {
  commands.set(id, command)
  if (commands.size > 200) {
    commands.delete(commands.keys().next().value ?? '')
  }
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content) && content.every(b => (b as { type?: unknown }).type === 'text')) {
    return content.map(b => String((b as { text?: unknown }).text ?? '')).join('\n')
  }
  return undefined
}

// The rtk binary, when it is on PATH: checked once per load, never waited on at startup.
let rtk: Promise<boolean> = Promise.resolve(false)

async function viaRtk($: $, command: string, raw: string, cfg: Config): Promise<string | undefined> {
  const filter = cfg.useRtk ? rtkFilter(command) : undefined
  if (filter === undefined || !(await rtk)) {
    return undefined
  }
  try {
    const r = await $.process.run(['rtk', 'pipe', '-f', filter], { stdin: raw, timeoutMs: 5_000 })
    const out = r.stdout.trim()
    // A summary that lost the failures the output shows is a false "all good": the output goes to compress().
    return r.exitCode === 0 && out !== '' && out.length < raw.length && keepsSignal(raw, out) ? out : undefined
  } catch {
    return undefined
  }
}

// Where the next full output goes: a ring of TEE_SLOTS files. The ring's start is read from the store once per
// load (so it carries on across sessions) and every slot after it is counted here, synchronously, so two
// results stored at the same moment never share a slot.
let teeStart: Promise<number> | undefined
let teeTaken = 0

/**
 * Keeps the whole output on disk, so nothing compression drops is lost for good: a ring of TEE_SLOTS files
 * under the Claude config folder (private to you, unlike /tmp), each headed by the call it holds.
 */
async function tee($: $, id: string, command: string, raw: string): Promise<string | undefined> {
  try {
    teeStart ??= $.store.get('teeSlot').then(v => Number(v ?? 0), () => 0)
    const taken = teeTaken++
    const slot = ((await teeStart) + taken) % TEE_SLOTS
    await storeUpdate<number>($, 'teeSlot', () => slot + 1)
    const base = await configBase($)
    const path = `${base}/model-router/tee/${slot}.txt`
    await $.fs.write(path, `# model-router: full output of ${id}: ${command.slice(0, 200)}\n${raw}`)
    return path
  } catch {
    return undefined
  }
}

type Block = { type: string; [field: string]: unknown }

async function shrink($: $, block: Block, cfg: Config): Promise<Block> {
  const id = String(block.tool_use_id ?? '')
  const command = commands.get(id)
  commands.delete(id)
  const family = command === undefined ? undefined : familyOf(command)
  const raw = textOf(block.content)
  // Claude Code already moved a very large output to a file and left a 2 KB preview: nothing to gain there.
  if (command === undefined || family === undefined || raw === undefined || raw.length < MIN_CHARS || raw.includes('<persisted-output>')) {
    return block
  }

  const filtered = await viaRtk($, command, raw, cfg)
  let body = filtered ?? compress(raw, family, { allowCut: true }).text
  if (body === raw) {
    return block
  }
  // Whatever is no longer in the result is on disk, or the result does not drop it.
  const path = await tee($, id, command, raw)
  if (path === undefined && filtered === undefined) {
    body = compress(raw, family, { allowCut: false }).text
  }
  const out = path === undefined ? body : `${body}\n[model-router: ${filtered === undefined ? 'compressed' : 'filtered by rtk'}; full output: '${path}' (grep or sed -n it)]`
  // The note counts against the saving: under 10% saved, the output goes as it came.
  if (out.length > raw.length * 0.9) {
    return block
  }
  await bill($, { compressions: 1, rawChars: raw.length, keptChars: out.length })
  return { ...block, content: typeof block.content === 'string' ? out : [{ type: 'text', text: out }] }
}

async function report($: $, cfg: Config): Promise<string> {
  const session = await read($, ledger)
  const all = { ...emptyLedger(), ...((await $.store.get('ledger')) as Ledger | undefined) }
  const r = await read($, route)
  const manual = await read($, isManual)
  const base = (await read($, sessionModel)) ?? 'your /model'
  const s = (await read($, style)) ?? cfg.style
  const learned = cfg.adapt ? learnedLine(await biasOf($), await $.clock.now()) : undefined
  const turns = (l: Ledger) => ORDER.filter(t => l.turns[t] > 0).map(t => `${NAME[t]} ${l.turns[t]}`).join(' · ') || '—'
  const money = (l: Ledger) =>
    l.baselineUsd === 0 ? '—' : `≈${dollars(saved(l))}: ${dollars(l.actualUsd)} spent instead of ${dollars(l.baselineUsd)}, ${l.routedSteps} requests routed, judge ${l.judgeCalls}× ${dollars(l.judgeUsd)}`
  const kept = (l: Ledger) => (l.compressions === 0 ? '—' : `${l.compressions}× · ${size(l.rawChars)} → ${size(l.keptChars)} chars · ≈${size((l.rawChars - l.keptChars) / 4)} tokens kept out of context`)
  return [
    `model-router · ${cfg.mode} · ${manual ? 'off (/model was changed by hand; /router on resumes)' : r === null ? 'not routed yet' : describe(r)} · style ${s} · compression ${cfg.compress ? 'on' : 'off'}${cfg.useRtk && (await rtk) ? ' (rtk)' : ''}`,
    '',
    `| | this session | all time |`,
    `|---|---|---|`,
    `| turns | ${turns(session)} | ${turns(all)} |`,
    `| saved vs ${base} | ${money(session)} | ${money(all)} |`,
    `| switches / holds | ${session.switches} / ${session.holds} | ${all.switches} / ${all.holds} |`,
    `| bash output | ${kept(session)} | ${kept(all)} |`,
    '',
    `learned: ${cfg.adapt ? (learned ?? 'nothing yet') : 'off'} · effort ${cfg.effortMode} · ultracode ${cfg.ultracode}`,
    '',
    '`/router why` · `/router off|on` · `/router style terse|adhd|off` · `/router log` · `/router reset` · prefix a prompt with `!haiku` `!sonnet` `!opus`, or nudge with `!+` `!-`',
  ].join('\n')
}

async function runRouter($: $, args: string, cfg: Config): Promise<{ text: string }> {
    const [sub = '', arg = ''] = args.trim().toLowerCase().split(/\s+/)
    if (sub === 'help' || sub === 'commands') {
      return { text: HELP }
    }
    if (sub === 'start') {
      const model = await $.session.model()
      await update($, isManual, () => false)
      await update($, sessionModel, () => model)
      const current = (await read($, style)) ?? cfg.style
      const r = await read($, route)
      return {
        text: [
          `model-router: ready — ${cfg.mode === 'crew' ? `crew, ${NAME[cfg.orchestrator]} orchestrates` : `route mode, from ${model}`}`,
          `style ${current} · compression ${cfg.compress ? 'on' : 'off'}${cfg.useRtk && (await rtk) ? ' (rtk)' : ''} · effort ${cfg.effortMode} · ultracode ${cfg.ultracode} · learning ${cfg.adapt ? 'on' : 'off'}`,
          r === null ? 'not routed yet — the next prompt is routed.' : `current route: ${describe(r)}.`,
          'Type `/router-help` for every command and what it is for.',
        ].join('\n'),
      }
    }
    if (sub === 'effort') {
      const learned = cfg.adapt ? learnedLine(await biasOf($), await $.clock.now()) : undefined
      if (arg === 'auto' || arg === 'task' || arg === 'fixed') {
        cfg.effortMode = arg
        return { text: `model-router: effort mode ${arg} for this session. Set the default in /config; \`/router-effort\` shows the policy.` }
      }
      const r = await read($, route)
      const policy = cfg.effortMode === 'auto'
        ? 'auto: a task moves one step from the tier base, taken only when the cache math says it pays'
        : cfg.effortMode === 'task'
          ? 'task: always take the task effort, even when the cache rewrite costs more'
          : 'fixed: the tier base effort only'
      return {
        text: [
          `model-router effort — ${cfg.effortMode} · ultracode ${cfg.ultracode} · learning ${cfg.adapt ? (learned ?? 'nothing yet') : 'off'}`,
          policy,
          `route: ${r === null ? 'not routed yet' : describe(r)} · bases: Haiku low, Sonnet medium, Opus high, Fable xhigh (Extra in Desktop)`,
          'The router never sends Max or Ultracode as an effort. Ultracode is a multi-agent switch for the hardest tasks; set it in /config. Change the session mode with `/router-effort auto|task|fixed`.',
        ].join('\n'),
      }
    }
    if (sub === 'panel') {
      const opened = await $.ui.open({ id: PANE, title: 'Model router' })
      return { text: opened.isPlaced ? 'Model router pane opened.' : `The pane could not open here: ${opened.reason}` }
    }
    if (sub === 'off') {
      await update($, isManual, () => true)
      await update($, route, () => null)
      $.ui.status('router: off')
      return {
        text:
          cfg.mode === 'crew'
            ? 'model-router: crew off for this session; the session keeps /model and stops delegating (the system prompt changes once, so the next request re-reads the conversation uncached). `/router on` resumes.'
            : 'model-router: routing off for this session; requests go to /model. `/router on` resumes.',
      }
    }
    if (sub === 'on') {
      const model = await $.session.model()
      await update($, isManual, () => false)
      await update($, sessionModel, () => model)
      $.ui.status(undefined)
      return { text: `model-router: routing on; the next prompt is routed (from ${model}).` }
    }
    if (sub === 'style') {
      const current = (await read($, style)) ?? cfg.style
      if (!isStyle(arg)) {
        return { text: `model-router: style is ${current}; choose terse, adhd or off.` }
      }
      if (arg !== current) {
        // The system prompt changes after the shared part: every model re-writes the conversation once.
        await update($, style, () => arg)
        await shrinkCaches($, 0)
      }
      return { text: `model-router: style ${arg}. The system prompt changes once, so the next request re-reads the conversation uncached.` }
    }
    if (sub === 'why') {
      const entries = ((await $.store.get('log')) as unknown[] | undefined) ?? []
      const text = explainDecision(lastDecision(entries))
      const ultra = lastUltracodeAfter(entries)
      return { text: ultra === undefined ? text : `${text}\n${explainDecision(ultra)}` }
    }
    if (sub === 'ultracode') {
      if (arg === 'suggest' || arg === 'auto' || arg === 'off') {
        cfg.ultracode = arg
        return { text: `model-router: ultracode ${arg} for this session. Set the default in /config; \`/router-ultracode\` shows the current mode.` }
      }
      return {
        text: [
          `model-router ultracode — ${cfg.ultracode}`,
          'suggest: name the keyword in the status line for the hardest tasks',
          'auto: add the keyword to the prompt (multi-agent workflow; dearer per turn, often done sooner and cheaper overall)',
          'off: say nothing',
          'Set it for this session with `/router-ultracode suggest|auto|off`; the default lives in /config.',
        ].join('\n'),
      }
    }
    if (sub === 'log') {
      const entries = ((await $.store.get('log')) as unknown[] | undefined) ?? []
      return { text: entries.length ? entries.slice(-50).map(x => JSON.stringify(x)).join('\n') : 'model-router: nothing logged yet' }
    }
    if (sub === 'reset') {
      await $.store.delete('ledger')
      await $.store.delete('profile')
      await $.store.delete('log')
      await $.store.delete('adapt')
      try {
        const base = await configBase($)
        await $.fs.write(`${base}/model-router/decisions.json`, '[]')
      } catch {}
      return { text: 'model-router: all-time savings, learned turn profiles, what it learned from your corrections and the decision log are cleared.' }
    }
    return { text: await report($, cfg) }
}

export const register: Register = (on, options) => {
  const laya = String(options.layaUrl ?? '').trim().replace(/\/+$/, '')
  const key = String(options.layaApiKey ?? '')
  const cfg: Config = {
    mode: pick(options.mode, ['route', 'crew'] as const, 'crew'),
    orchestrator: pick(options.orchestrator, ['haiku', 'sonnet', 'opus'] as const, 'sonnet'),
    cache: CACHE[pick(options.cacheTtl, ['1h', '5m'] as const, '1h')],
    // Never `max` or `ultracode` as a router-sent effort: they become xhigh (Extra); Ultracode is the keyword switch.
    effort: Object.fromEntries(ORDER.map(t => [t, clampEffort(options[`${t}Effort`], EFFORT[t])])) as Record<Tier, Effort>,
    effortMode: pick(options.effortMode, ['auto', 'fixed', 'task'] as const, 'auto'),
    ultracode: pick(options.ultracode, ['suggest', 'auto', 'off'] as const, 'suggest'),
    adapt: pick(options.adapt, ['on', 'off'] as const, 'on') === 'on',
    enableFable: flag(options.enableFable, false),
    escalate: pick(options.escalate, ['auto', 'suggest'] as const, 'auto'),
    judge: pick(options.judge, ['haiku', 'off'] as const, 'haiku'),
    style: pick(options.style, ['terse', 'adhd', 'off'] as const, 'terse'),
    compress: flag(options.compress, true),
    useRtk: flag(options.useRtk, true),
    showNote: flag(options.showNote, true),
    layaUrl: laya,
    layaHeaders: key === '' ? {} : { authorization: `Bearer ${key}` },
  }
  // Crew spawns in flight, by tier: two Agent calls in one response must not both pass the check.
  const starting = new Set<Tier>()

  on('session.start', async ($, e, next) => {
    // Not awaited: startup never waits on a process.
    rtk = cfg.compress && cfg.useRtk
      ? $.process.run(['rtk', '--version'], { timeoutMs: 3_000 }).then(r => r.exitCode === 0 && /^rtk\s/.test(r.stdout)).catch(() => false)
      : Promise.resolve(false)
    for (const command of COMMANDS) {
      try {
        await $.command.register(command)
      } catch {}
    }
    $.ui.open({ id: PANE, title: 'Model router' }).catch(() => {})
    if (cfg.mode === 'crew') {
      for (const t of WORKERS) {
        try {
          await $.agent.register(workerSpec(t, MODEL[t], cfg.effort[t]))
        } catch {}
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const r = await read($, route)
    const manual = await read($, isManual)
    const s = (await read($, style)) ?? cfg.style
    const total = ORDER.reduce((n, t) => n + l.turns[t], 0)
    return (
      <Box flexDirection="column">
        <Text bold>{manual ? 'off · /router on' : r === null ? 'not routed yet' : describe(r)}</Text>
        <Text color="green">saved {l.baselineUsd === 0 ? '—' : `≈${dollars(saved(l))}`}</Text>
        {ORDER.filter(t => l.turns[t] > 0).map(t => (
          <Text>
            {`${NAME[t].padEnd(7)}${'█'.repeat(Math.max(1, Math.round((l.turns[t] / total) * 12)))} ${l.turns[t]}`}
          </Text>
        ))}
        <Text dimColor>
          {l.compressions === 0 ? 'no compression yet' : `≈${size((l.rawChars - l.keptChars) / 4)} tokens kept out`} · {cfg.mode} · {s}
        </Text>
      </Box>
    )
  })

  on('command.run', { command: 'router' }, async ($, e) => runRouter($, e.args, cfg))
  on('command.run', { command: 'router-help' }, async ($) => runRouter($, 'help', cfg))
  on('command.run', { command: 'router-start' }, async ($) => runRouter($, 'start', cfg))
  on('command.run', { command: 'router-why' }, async ($) => runRouter($, 'why', cfg))
  on('command.run', { command: 'router-effort' }, async ($, e) => runRouter($, e.args === '' ? 'effort' : `effort ${e.args}`, cfg))
  on('command.run', { command: 'router-ultracode' }, async ($, e) => runRouter($, e.args === '' ? 'ultracode' : `ultracode ${e.args}`, cfg))
  on('command.run', { command: 'router-log' }, async ($) => runRouter($, 'log', cfg))
  on('command.run', { command: 'router-panel' }, async ($) => runRouter($, 'panel', cfg))
  on('command.run', { command: 'router-style' }, async ($, e) => runRouter($, `style ${e.args}`, cfg))
  on('command.run', { command: 'router-off' }, async ($) => runRouter($, 'off', cfg))
  on('command.run', { command: 'router-on' }, async ($) => runRouter($, 'on', cfg))
  on('command.run', { command: 'router-reset' }, async ($) => runRouter($, 'reset', cfg))

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta === true) {
      return next(e)
    }
    // Opened at start the pane waits for a wide window; a prompt the person entered places it at any width, once.
    if (!(await read($, paneAsked))) {
      await update($, paneAsked, () => true)
      $.ui.open({ id: PANE, title: 'Model router' }).catch(() => {})
    }
    const parsedPrefix = e.command === undefined ? parsePrefix(e.text) : { text: e.text, forced: null, nudge: 0 as const, raw: '' }
    if (await read($, isManual)) {
      // Routing is off: a !tier, !+ or !- prefix is still not meant for the model.
      if (parsedPrefix.raw === '') {
        return next(e)
      }
      $.ui.status(`router: off, so ${parsedPrefix.raw.trim()} was ignored (/router on resumes)`)
      return next({ ...e, text: parsedPrefix.text })
    }
    let forcedTier = parsedPrefix.forced
    const forcedWhy = parsedPrefix.nudge === 0 ? 'forced' : parsedPrefix.nudge > 0 ? 'forced +1' : 'forced -1'
    const text = parsedPrefix.text
    if (parsedPrefix.nudge !== 0) {
      const base = await baseTier($, cfg)
      const nudged = parsedPrefix.nudge > 0 ? nextTier(base, cfg.enableFable) : prevTier(base)
      if (nudged === undefined) {
        const edge = parsedPrefix.nudge > 0 ? 'strongest' : 'cheapest'
        const message = `already at the ${edge} tier (${NAME[base]})`
        await update($, note, () => `model-router: ${message}`)
        await status($, message)
        await log($, 'route', {
          tier: base,
          effort: (await read($, baseEffort)) ?? null,
          source: 'forced',
          confidence: 1,
          why: forcedWhy,
          decision: message,
          taken: false,
          from: base,
          context: await read($, context),
          prompt: text.slice(0, 280),
        })
        return next({ ...e, text })
      }
      forcedTier = nudged
    }
    if (cfg.mode === 'crew') {
      // Crew never switches models, so a prompt typed during a turn takes its hint now, like any other.
      const hint = e.command === undefined ? await delegation($, text, forcedTier, cfg) : undefined
      const asked = e.command === undefined && e.turnId === undefined && forcedTier === null
        ? await ultracode($, text, heuristic(text, cfg.enableFable, { failedTools: await read($, strikes) }), cfg)
        : text
      return next(hint === undefined ? { ...e, text: asked } : { ...e, text: asked, context: [...(e.context ?? []), hint] })
    }
    // Typed during a running turn: it runs on that turn's model, or waits for a turn of its own, routed then.
    if (e.turnId !== undefined) {
      if (e.command === undefined) {
        await update($, queued, q => [...q, { text, tier: forcedTier, why: forcedWhy, nudge: parsedPrefix.nudge }].slice(-QUEUE_CAP))
      }
      return next(parsedPrefix.raw === '' ? e : { ...e, text })
    }
    // A prompt that ran inside an earlier turn and is now typed again is a new prompt, routed here.
    if ((await read($, queued)).some(q => q.text === text)) {
      await update($, queued, q => q.filter(x => x.text !== text))
    }
    if (e.command !== undefined) {
      // A user or plugin command (a skill): routed by what was typed and what the command says it does, not by
      // its expanded instructions, whose length and vocabulary say nothing about this task.
      const command = (await $.command.list()).find(c => c.name === e.command?.name)
      if (command !== undefined && e.command.name !== 'router') {
        if (command.source === 'user' || command.source === 'plugin') {
          await enter($, `${e.command.args}\n(${command.description})`, null, cfg)
        } else {
          // Claude Code's own prompt commands (/code-review, /security-review, /init) and MCP prompts: no rule
          // reads them well, and they should not inherit the last prompt's cheaper tier. Your /model runs them.
          await update($, note, () => null)
          await update($, route, () => null)
        }
      }
      return next(e)
    }
    const verdict = await enter($, text, forcedTier, cfg, forcedWhy, parsedPrefix.nudge)
    const asked = await ultracode($, text, verdict, cfg)
    return next(parsedPrefix.raw === '' && asked === text ? e : { ...e, text: asked })
  }).catch(($, e, next) => next(e)) // routing is best effort: never hold a prompt back

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, steps, () => 0)
      await update($, turnFirst, () => 0)
      await update($, turnLast, () => 0)
      await update($, strikes, () => 0)
      await update($, lastCall, () => null)
      await update($, hasEscalated, () => false)
      // A prompt that waited behind the last turn is routed now that its own turn begins.
      const waiting = (await read($, queued)).find(q => q.text === e.text)
      if (waiting !== undefined && !(await read($, isManual))) {
        await update($, queued, q => q.filter(x => x !== waiting))
        await enter($, waiting.text, waiting.tier, cfg, waiting.why, waiting.nudge)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      try {
        const base = await read($, sessionModel)
        const u = result.usage
        const id = e.agentId
        if (u !== null && (await read($, workers)).includes(id)) {
          const prompt = promptOf(u)
          await update($, workerWarm, w => ({ ...w, [id]: { tokens: prompt, at: startedAt, first: w[id]?.first ?? prompt } }))
        }
        if (u !== null && base !== null && (await read($, workers)).includes(id)) {
          // A worker's request against the same request made by a subagent on the session's own model.
          const actual = usd(u.model || e.model, u, cfg.cache)
          const would = usd(base, u, cfg.cache)
          if (actual !== undefined && would !== undefined) {
            await bill($, { routedSteps: 1, actualUsd: actual, baselineUsd: would })
          }
        }
      } catch {}
      return result
    }

    const chosen = await read($, route)
    // An /effort typed by hand after a routed prompt: this kind of task wants more (or less) than it got.
    const before = await read($, baseEffort)
    if (chosen !== null && before !== null && e.effort !== undefined && e.effort !== before && !(await read($, isManual))) {
      await correct($, cfg, await read($, category), 'effort', ALL_EFFORTS.indexOf(String(e.effort)) - ALL_EFFORTS.indexOf(String(before)))
    }
    await update($, baseEffort, () => e.effort ?? null)
    let routed = e
    if (chosen !== null && !(await read($, isManual))) {
      // A /model by hand after routing wins for the rest of the session (classic.PostModelSwitch says so first,
      // where the build raises it; this catches the rest).
      const recorded = await read($, sessionModel)
      const model = await $.session.model()
      if (recorded !== null && canonical(model) !== canonical(recorded)) {
        const to = tierOf(model)
        if (to !== undefined) {
          await correct($, cfg, await read($, category), 'tier', rank(to) - rank(chosen.tier))
        }
        await update($, isManual, () => true)
        await update($, route, () => null)
        $.ui.status('router: /model changed by hand, routing off (/router on resumes)')
        await log($, 'manual', { from: chosen.tier, to: model })
      } else if (tierOf(e.model) !== chosen.tier) {
        // On the session's own tier the request goes out as the session made it: same id, same effort, same cache.
        routed = { ...e, model: chosen.model, effort: chosen.effort }
      } else if (chosen.setsEffort === true && e.effort !== chosen.effort) {
        // Same model, the task's own effort: the cache math in apply() found it costs nothing more.
        routed = { ...e, effort: chosen.effort }
      }
    }
    const n = await update($, steps, k => k + 1)

    const result = yield* next(routed)
    // Never throw from here: the request already ran.
    try {
      const u = result.usage
      if (u !== null) {
        const prompt = promptOf(u)
        const total = prompt + u.output_tokens
        const sent: Sent = { model: routed.model, effort: routed.effort ?? null }
        await update($, context, () => total)
        await update($, prefix, p => (p === 0 ? prompt : p))
        await update($, lastSent, () => sent)
        // The cache now holds this request's prompt (its answer is written by the next request), and the entry
        // lives from when the request was made, not from when its answer arrived.
        await update($, warm, w => ({ ...w, [cacheKey(sent.model, sent.effort ?? undefined)]: { tokens: prompt, at: startedAt } }))
        await update($, turnLast, () => prompt)
        if (n === 1) {
          await update($, turnFirst, () => prompt)
        }
        if (!(await read($, isManual))) {
          // The baseline: this request on the session's own model, read from that model's own cache as it would
          // stand had every request gone there. A switch's cache write then shows as the cost it is.
          const was = await read($, shadow)
          const baseline = requestCost(e.model, prompt, cachedOf(was ?? undefined, prompt, startedAt, cfg.cache), u.output_tokens, cfg.cache)
          const actual = requestCost(u.model || routed.model, prompt, u.cache_read_input_tokens, u.output_tokens, cfg.cache)
          await update($, shadow, () => ({ tokens: prompt, at: startedAt }))
          if (baseline !== undefined && actual !== undefined) {
            await bill($, { routedSteps: canonical(routed.model) === canonical(e.model) ? 0 : 1, actualUsd: actual, baselineUsd: baseline })
          }
        }
      }
    } catch {}
    return result
  })

  // The desktop app draws no status line, so the route is also shown beneath the main answer.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      return done
    }
    try {
      const r = await read($, route)
      if (r !== null) {
        await bill($, { turns: { [r.tier]: 1 } })
      }
      // The turn's shape is learned into the tier of the task it was, not the model it ran on; crew turns and
      // turns that escalated midway say nothing about a task tier.
      const task = await read($, taskTier)
      const n = await read($, steps)
      if (task !== null && cfg.mode === 'route' && !(await read($, hasEscalated)) && e.usage !== undefined && e.reason === 'answer' && n > 0) {
        const added = n > 1 ? ((await read($, turnLast)) - (await read($, turnFirst))) / (n - 1) : undefined
        const output = e.usage.output_tokens
        await storeUpdate<Partial<Record<Tier, Partial<Profile>>>>($, 'profile', stored => ({ ...stored, [task]: learn(stored?.[task] ?? {}, PROFILE[task], n, output, added) }))
      }
      const text = await read($, note)
      if (cfg.showNote && text !== null) {
        return { ...done, text }
      }
    } catch {}
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const worker = cfg.mode === 'crew' && e.resume === undefined && !(await read($, isManual)) ? tierOfWorker(e.subagentType) : undefined
    if (worker !== undefined) {
      const name = workerName(worker)
      if (e.parentAgentId !== undefined && (await read($, workers)).includes(e.parentAgentId)) {
        return deny(e.tool_use_id, 'A worker does its task itself: do the work here and report.')
      }
      // One worker per model, while reusing it is cheaper than a fresh one. Two calls in one response must not
      // both pass the check, hence the synchronous claim.
      if (starting.has(worker)) {
        return deny(e.tool_use_id, `${name} is being started by another call: wait for it, then send it this task with SendMessage.`)
      }
      starting.add(worker)
      try {
        // A spawn under another name (worker-opus-2) is the way past a worker that stopped answering.
        const isFresh = e.name !== undefined && e.name !== name
        const live = isFresh ? undefined : await liveWorker($, worker)
        if (live !== undefined && (await reuseIsCheaper($, live.id, worker, cfg))) {
          const to = addressOf(live)
          const resumes = live.status === 'completed' ? ' (it resumes with what it learned)' : ''
          return deny(e.tool_use_id, `${name} is already started: send this task with SendMessage to "${to}"${resumes}, so it keeps its warm cache. If it does not answer, spawn again with name "${name}-2".`)
        }
        const started = await next({ ...e, subagentType: workerType(worker), model: MODEL[worker] })
        if (started.agentId !== undefined) {
          const id = started.agentId
          await update($, workers, w => [...w, id].slice(-50))
        }
        return started
      } finally {
        starting.delete(worker)
      }
    }
    // Crew mode leaves every other agent alone: the orchestrator's model is a setting, not a judgment of the task.
    if (cfg.mode === 'crew') {
      return next(e)
    }
    // A general-purpose subagent inherits the session's model; on a cheaper turn it takes the turn's model.
    // Every other agent type may pin its own model in its definition, which this hook cannot see: left alone.
    const r = await read($, route)
    const inherits = e.subagentType === 'general-purpose' && e.provider.plugin === 'engine' && !e.fork && e.isTeammate !== true && e.model === undefined
    if (r === null || !inherits || rank(r.tier) >= rank('opus') || (await read($, isManual))) {
      return next(e)
    }
    return next({ ...e, model: r.model })
  }).catch(($, e, next) => next(e))

  // Struggling: tools keep failing, or the same call comes back. Escalate once per turn (or suggest it).
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      remember(e.tool_use_id, e.command)
    }
    const result = await next(e)
    try {
      const r = e.agentId === undefined ? await read($, route) : null
      if (r !== null) {
        const call = JSON.stringify({ ...e, tool_use_id: undefined })
        const isRetry = call === (await read($, lastCall))
        await update($, lastCall, () => call)
        const failed = result.deny === undefined && result.isError === true && !denied.has(e.tool_use_id)
        const n = await update($, strikes, k => (failed || isRetry ? k + 1 : 0))
        const up = cfg.mode === 'crew' ? WORKERS[WORKERS.indexOf(r.tier) + 1] : ORDER[rank(r.tier) + 1]
        if (n >= STRIKES && up !== undefined && (up !== 'fable' || cfg.enableFable) && !(await read($, hasEscalated))) {
          await update($, hasEscalated, () => true)
          const reason = failed ? 'tools keep failing' : 'going in circles'
          await correct($, cfg, await read($, category), 'tier', 1)
          if (cfg.mode === 'crew') {
            await status($, `${reason}: hand it to ${workerName(up)}`)
          } else if (cfg.escalate === 'auto') {
            await update($, route, () => ({ tier: up, model: MODEL[up], effort: cfg.effort[up], source: 'escalated', confidence: 1 }))
            await update($, note, () => `model-router: escalated to ${NAME[up]} · ${reason}`)
            await bill($, { switches: 1 })
            await status($, `${reason} → ${NAME[up]}`)
          } else {
            await status($, `${reason}, consider !${up}`)
          }
          await log($, 'escalate', { from: r.tier, to: up, reason, taken: cfg.mode === 'route' && cfg.escalate === 'auto' })
        }
      }
    } catch {}
    return result
  }).catch(($, e, next) => next(e))

  // rtk-lite: Bash output shrinks before it is stored, so every later request carries the small version.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (!cfg.compress || e.origin.kind !== 'tool' || e.origin.tool !== 'Bash') {
      return next(e)
    }
    const content = []
    for (const block of e.message.content) {
      content.push(block.type === 'tool_result' ? await shrink($, block, cfg) : block)
    }
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  // Who changed the model: the person (routing stops), the engine's own fallback (routing pauses until the next
  // prompt and the new model becomes the baseline), or a resumed session (a new baseline).
  on('classic.PostModelSwitch', async ($, e, next) => {
    try {
      if (e.source === 'command' || e.source === 'picker' || e.source === 'sdk') {
        const r = await read($, route)
        if (!(await read($, isManual)) && r !== null) {
          await log($, 'manual', { to: e.to_model, source: e.source })
          const to = tierOf(e.to_model)
          if (to !== undefined) {
            await correct($, cfg, await read($, category), 'tier', rank(to) - rank(r.tier))
          }
        }
        await update($, isManual, () => true)
        await update($, route, () => null)
      } else {
        await update($, sessionModel, () => e.to_model)
        if (e.source === 'auto') {
          await update($, route, () => null)
          await log($, 'fallback', { from: e.from_model, to: e.to_model })
        }
      }
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear starts a new conversation and /resume another one: only the system prompt and tools stay cached.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      const keep = await read($, prefix)
      await update($, route, () => null)
      await update($, context, () => keep)
      await update($, queued, () => [])
      await shrinkCaches($, keep)
      if (e.reason === 'resume') {
        await update($, sessionModel, () => null)
        await update($, isManual, () => false)
        await update($, lastSent, () => null)
      }
    }
    return next(e)
  })

  // A compaction replaces the conversation with its summary: the caches keep the system prompt and tools.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
        const keep = await read($, prefix)
        await update($, context, () => done.tokensAfter ?? keep)
        await shrinkCaches($, keep)
      }
    } catch {}
    return done
  }).catch(($, e, next) => next(e))

  // Output economy: one section at the end of the system prompt, inside the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) {
      return composed
    }
    const added = []
    const isTeammate = e.traits.includes('teammate')
    const chosen = (await read($, style)) ?? cfg.style
    // A teammate's reader is the orchestrator, not the person: it gets the terse rules, never the ADHD shape.
    const text = STYLE[isTeammate && chosen === 'adhd' ? 'terse' : chosen]
    if (text !== undefined) {
      added.push({ id: 'model-router:style', text, scope: 'session' as const })
    }
    if (cfg.mode === 'crew' && !isTeammate && e.tools.includes('Agent') && !(await read($, isManual))) {
      added.push({ id: 'model-router:crew', text: crewSection(cfg.orchestrator, WORKERS, e.tools.includes('SendMessage')), scope: 'session' as const })
    }
    return added.length === 0 ? composed : { sections: [...composed.sections, ...added] }
  })
}
