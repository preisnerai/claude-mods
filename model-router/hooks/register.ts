import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Ledger, Route, Style, Tier } from '../types'
import { ORDER, heuristic, isFollowUp, layaQuestion, parseJudge, parseLaya, rank, rubric, words } from './classify'
import type { Verdict } from './classify'
import { MIN_CHARS, compress, familyOf, rtkFilter } from './compress'
import { CACHE, PROFILE, addLedger, cacheKey, dollars, emptyLedger, learn, saved, size, switchDelta, usd } from './cost'
import type { Cache, LedgerDelta, Profile } from './cost'
import { WORKERS, crewSection, delegationHint, tierOfWorker, workerName, workerSpec } from './crew'
import { STYLE, isStyle } from './style'

// Model per tier. Change the ids here to re-route.
const MODEL: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}
const NAME: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
const EFFORT: Record<Tier, Effort> = { haiku: 'low', sonnet: 'medium', opus: 'high', fable: 'xhigh' }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Hand override for one prompt: "!opus przeprojektuj ten moduł".
const FORCE = /^!(haiku|sonnet|opus|fable)\s+/i

// Failed or repeated tool calls in a row before the router escalates (or suggests it).
const STRIKES = 3
const LAYA_TIMEOUT_MS = 4_000
const LOG_CAP = 500
const TEE_SLOTS = 200

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const sessionModel = atom({ plugin: 'model-router', key: 'sessionModel' } as const, null)
const isManual = atom({ plugin: 'model-router', key: 'isManual' } as const, false)
const pending = atom({ plugin: 'model-router', key: 'pending' } as const, null)
const context = atom({ plugin: 'model-router', key: 'context' } as const, 0)
const warm = atom({ plugin: 'model-router', key: 'warm' } as const, {})
const steps = atom({ plugin: 'model-router', key: 'steps' } as const, 0)
const strikes = atom({ plugin: 'model-router', key: 'strikes' } as const, 0)
const lastCall = atom({ plugin: 'model-router', key: 'lastCall' } as const, null)
const hasEscalated = atom({ plugin: 'model-router', key: 'hasEscalated' } as const, false)
const style = atom({ plugin: 'model-router', key: 'style' } as const, null)
const ledger = atom({ plugin: 'model-router', key: 'ledger' } as const, emptyLedger())
const note = atom({ plugin: 'model-router', key: 'note' } as const, null)

type $ = EngineInterface

type Config = {
  mode: 'route' | 'crew'
  orchestrator: Tier
  cache: Cache
  effort: Record<Tier, Effort>
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

/** The tier a model id belongs to, for a session that has not been routed yet. */
function tierOf(model: string): Tier | undefined {
  return ORDER.find(t => model.toLowerCase().includes(t))
}

function describe(r: Route): string {
  const how = r.source === 'rule' || r.source === 'judge' || r.source === 'laya' ? `${r.source} ${r.confidence.toFixed(2).replace(/^0/, '')}` : r.source
  return `${NAME[r.tier]}·${r.effort} (${how})`
}

// Calibration data: what was routed and why, read back with /router log.
async function log($: $, event: string, data: Record<string, unknown>) {
  try {
    const entries = ((await $.store.get('log')) as unknown[] | undefined) ?? []
    const entry = { at: new Date(await $.clock.now()).toISOString(), event, ...data }
    await $.store.set('log', [...entries, entry].slice(-LOG_CAP))
  } catch {}
}

/** Adds to this session's ledger and to the one kept across sessions. */
async function bill($: $, delta: LedgerDelta) {
  await update($, ledger, l => addLedger(l, delta))
  try {
    const all = (await $.store.get('ledger')) as Ledger | undefined
    await $.store.set('ledger', addLedger({ ...emptyLedger(), ...all }, delta))
  } catch {}
}

async function profiles($: $): Promise<Record<Tier, Profile>> {
  try {
    return { ...PROFILE, ...((await $.store.get('profile')) as Partial<Record<Tier, Profile>> | undefined) }
  } catch {
    return PROFILE
  }
}

async function status($: $, text: string) {
  const l = await read($, ledger)
  const money = l.routedSteps > 0 ? ` · saved ≈${dollars(saved(l))}` : ''
  $.ui.status(`router: ${text}${money}`)
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
    maxTokens: 64,
    effort: 'low',
    timeoutMs: 8_000,
  })
  await bill($, { judgeCalls: 1, judgeUsd: usd(MODEL.haiku, reply.usage) ?? 0 })
  const tier = reply.isAnswered ? parseJudge(reply.text, cfg.enableFable) : undefined
  return tier === undefined ? undefined : { tier, confidence: 0.7, source: 'judge', why: 'judge' }
}

/** Local rules first (no tokens, no wait); laya-serve or the Haiku judge only for what they cannot call. */
async function classify($: $, text: string, cfg: Config): Promise<Verdict | undefined> {
  const local = heuristic(text, cfg.enableFable)
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

/**
 * Moves the main loop to the verdict's tier when that is worth it.
 *
 * A model switch re-reads the whole conversation into the new model's cache, so a cheaper tier is taken only
 * when the turn it saves on outweighs that write. A harder tier is about quality, not money: `escalate: auto`
 * takes it, `suggest` names it in the status line and leaves the switch to the person.
 */
async function apply($: $, verdict: Verdict, cfg: Config) {
  const target: Route = { tier: verdict.tier, model: MODEL[verdict.tier], effort: cfg.effort[verdict.tier], source: verdict.source, confidence: verdict.confidence }
  const recorded = await read($, sessionModel)
  if (recorded === null) {
    const model = await $.session.model()
    await update($, sessionModel, () => model)
  }
  const current = await read($, route)
  const fromModel = current?.model ?? (await read($, sessionModel)) ?? target.model
  const fromTier = current?.tier ?? tierOf(fromModel)
  const tokens = await read($, context)

  let take = true
  let why = verdict.why
  if (verdict.source !== 'forced' && tokens > 0 && fromTier !== undefined && fromTier !== target.tier) {
    const profile = (await profiles($))[verdict.tier]
    const delta = switchDelta(fromModel, target.model, tokens, await read($, warm), await $.clock.now(), profile, cfg.cache)
    if (rank(target.tier) < rank(fromTier)) {
      take = delta === undefined || delta < 0
      why = delta === undefined ? why : take ? `saves ≈${dollars(-delta)}` : `switching costs ${dollars(delta)} more (cache)`
    } else {
      take = cfg.escalate === 'auto'
      why = delta === undefined ? why : `${take ? '' : 'consider !' + target.tier + ': '}+${dollars(delta)} cache re-read`
    }
    await bill($, take ? { switches: 1 } : { holds: 1 })
  }
  await log($, 'route', { tier: verdict.tier, source: verdict.source, confidence: Number(verdict.confidence.toFixed(2)), why: verdict.why, taken: take, from: fromTier ?? null, context: tokens })

  if (take) {
    await update($, route, () => target)
    await update($, note, () => `model-router: ${NAME[target.tier]} · ${verdict.why}`)
    await status($, `${describe(target)}${why === verdict.why ? '' : ' · ' + why}`)
  } else {
    const kept = current ?? null
    const name = fromTier === undefined ? fromModel : NAME[fromTier]
    await update($, note, () => `model-router: stayed on ${name} · ${why}`)
    await status($, `${kept === null ? name : describe(kept)} · ${verdict.tier} task, ${why}`)
  }
}

/** Crew mode: the main loop stays on the orchestrator for the whole session, so its cache is never thrown away. */
async function pinOrchestrator($: $, cfg: Config): Promise<Route> {
  const t = cfg.orchestrator
  const pinned: Route = { tier: t, model: MODEL[t], effort: cfg.effort[t], source: 'crew', confidence: 1 }
  const current = await read($, route)
  if (current?.source !== 'crew') {
    await update($, route, () => pinned)
    if ((await read($, sessionModel)) === null) {
      const model = await $.session.model()
      await update($, sessionModel, () => model)
    }
  }
  return pinned
}

async function routePrompt($: $, text: string, cfg: Config) {
  const current = await read($, route)
  if (current !== null && isFollowUp(text)) {
    await update($, note, () => `model-router: ${NAME[current.tier]} · follow-up`)
    await status($, `${describe({ ...current, source: 'follow-up' })}`)
    return
  }
  // "hi" says too little to route: the session's /model answers it, and the next prompt routes.
  if (current === null && words(text) < 3) {
    return
  }
  const verdict = await classify($, text, cfg)
  if (verdict === undefined) {
    await status($, current === null ? 'unsure, using /model' : `${describe(current)} · unsure, kept`)
    return
  }
  await apply($, verdict, cfg)
}

// Crew workers by agent id: their steps are billed against the model the session would have done them on.
const workers = new Set<string>()

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
    return r.exitCode === 0 && out !== '' && out.length < raw.length ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Keeps the whole output on disk, so nothing compression drops is lost for good: a ring of TEE_SLOTS files
 * under the Claude config folder (private to you, unlike /tmp), each headed by the call it holds.
 */
async function tee($: $, id: string, command: string, raw: string): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)
    const base = (config ?? (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? '/tmp').replace(/[\\/]+$/, '')
    const slot = Number((await $.store.get('teeSlot')) ?? 0) % TEE_SLOTS
    await $.store.set('teeSlot', slot + 1)
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

  let out = await viaRtk($, command, raw, cfg)
  const path = await tee($, id, command, raw)
  if (out === undefined) {
    const c = compress(raw, family, { allowCut: path !== undefined })
    out = c.hidden > 0 ? `${c.text}\n[model-router: ${c.hidden} lines hidden${path ? `; full output: ${path} (grep or sed -n it)` : ''}]` : c.text
  } else if (path !== undefined) {
    out = `${out}\n[model-router: filtered by rtk; full output: ${path} (grep or sed -n it)]`
  }
  if (out.length >= raw.length) {
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
  const s = (await read($, style)) ?? cfg.style
  const turns = (l: Ledger) => ORDER.filter(t => l.turns[t] > 0).map(t => `${NAME[t]} ${l.turns[t]}`).join(' · ') || '—'
  const money = (l: Ledger) => `≈${dollars(saved(l))} (${l.routedSteps} routed steps: ${dollars(l.actualUsd)} instead of ${dollars(l.baselineUsd)}; judge ${l.judgeCalls}× ${dollars(l.judgeUsd)})`
  const kept = (l: Ledger) => (l.compressions === 0 ? '—' : `${l.compressions}× · ${size(l.rawChars)} → ${size(l.keptChars)} chars · ≈${size((l.rawChars - l.keptChars) / 4)} tokens kept out of context`)
  return [
    `model-router · ${manual ? 'off (/model was changed by hand; /router on resumes)' : r === null ? 'not routed yet' : describe(r)} · style ${s} · compression ${cfg.compress ? 'on' : 'off'}${cfg.useRtk && (await rtk) ? ' (rtk)' : ''}`,
    '',
    `| | this session | all time |`,
    `|---|---|---|`,
    `| turns | ${turns(session)} | ${turns(all)} |`,
    `| saved | ${money(session)} | ${money(all)} |`,
    `| switches / holds | ${session.switches} / ${session.holds} | ${all.switches} / ${all.holds} |`,
    `| bash output | ${kept(session)} | ${kept(all)} |`,
    '',
    '`/router off|on` · `/router style terse|adhd|off` · `/router log` · `/router reset` · prefix a prompt with `!haiku` `!sonnet` `!opus` to force it',
  ].join('\n')
}

export const register: Register = (on, options) => {
  const base = String(options.layaUrl ?? '').trim().replace(/\/+$/, '')
  const key = String(options.layaApiKey ?? '')
  const cfg: Config = {
    mode: pick(options.mode, ['route', 'crew'] as const, 'route'),
    orchestrator: pick(options.orchestrator, ['haiku', 'sonnet', 'opus'] as const, 'sonnet'),
    cache: CACHE[pick(options.cacheTtl, ['1h', '5m'] as const, '1h')],
    effort: Object.fromEntries(ORDER.map(t => [t, pick(options[`${t}Effort`], EFFORTS, EFFORT[t])])) as Record<Tier, Effort>,
    enableFable: flag(options.enableFable, false),
    escalate: pick(options.escalate, ['auto', 'suggest'] as const, 'auto'),
    judge: pick(options.judge, ['haiku', 'off'] as const, 'haiku'),
    style: pick(options.style, ['terse', 'adhd', 'off'] as const, 'terse'),
    compress: flag(options.compress, true),
    useRtk: flag(options.useRtk, true),
    showNote: flag(options.showNote, true),
    layaUrl: base,
    layaHeaders: key === '' ? {} : { authorization: `Bearer ${key}` },
  }

  on('session.start', async ($, e, next) => {
    // Not awaited: startup never waits on a process.
    rtk = cfg.compress && cfg.useRtk
      ? $.process.run(['rtk', '--version'], { timeoutMs: 3_000 }).then(r => r.exitCode === 0 && /^rtk\s/.test(r.stdout)).catch(() => false)
      : Promise.resolve(false)
    await $.command.register({ name: 'router', description: 'model-router: savings, route, style (/router off|on|style|log|reset)' })
    if (cfg.mode === 'crew') {
      for (const t of WORKERS) {
        try {
          await $.agent.register(workerSpec(t, MODEL[t], cfg.effort[t]))
        } catch {}
      }
    }
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub === 'off') {
      await update($, isManual, () => true)
      await update($, route, () => null)
      $.ui.status('router: off')
      return { text: 'model-router: routing off for this session; requests go to /model. `/router on` resumes.' }
    }
    if (sub === 'on') {
      const model = await $.session.model()
      await update($, isManual, () => false)
      await update($, sessionModel, () => model)
      $.ui.status(undefined)
      return { text: `model-router: routing on; the next prompt is routed (from ${model}).` }
    }
    if (sub === 'style') {
      if (!isStyle(arg)) {
        return { text: `model-router: style is ${(await read($, style)) ?? cfg.style}; choose terse, adhd or off.` }
      }
      await update($, style, () => arg)
      return { text: `model-router: style ${arg}. The system prompt changes once, so the next request re-reads the conversation uncached.` }
    }
    if (sub === 'log') {
      const entries = ((await $.store.get('log')) as unknown[] | undefined) ?? []
      return { text: entries.length ? entries.slice(-50).map(x => JSON.stringify(x)).join('\n') : 'model-router: nothing logged yet' }
    }
    if (sub === 'reset') {
      await $.store.delete('ledger')
      await $.store.delete('profile')
      await $.store.delete('log')
      return { text: 'model-router: all-time savings, learned turn profiles and the log are cleared.' }
    }
    return { text: await report($, cfg) }
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt that joins a running turn keeps that turn's model.
    if (e.turnId !== undefined) {
      return next(e)
    }
    await update($, note, () => null)
    await update($, hasEscalated, () => false)
    await update($, steps, () => 0)
    await update($, strikes, () => 0)
    if (e.isMeta === true || (await read($, isManual))) {
      return next(e)
    }
    if (cfg.mode === 'crew') {
      // No model switch ever: a prompt that needs another model becomes a hint to hand it to that worker.
      await pinOrchestrator($, cfg)
      if (e.command !== undefined) {
        return next(e)
      }
      const forced = FORCE.exec(e.text)
      const tier = forced !== null ? ((forced[1] ?? 'opus').toLowerCase() as Tier) : heuristic(e.text, false)?.tier
      const text = forced !== null ? e.text.slice(forced[0].length) : e.text
      if (tier === undefined || (tier === cfg.orchestrator && forced === null) || !WORKERS.includes(tier)) {
        return next({ ...e, text })
      }
      await update($, note, () => `model-router: crew · ${workerName(tier)}`)
      await status($, `crew · ${NAME[cfg.orchestrator]} orchestrates · ${tier} task → ${workerName(tier)}`)
      await log($, 'delegate', { tier, forced: forced !== null })
      return next({ ...e, text, context: [...(e.context ?? []), delegationHint(tier, forced !== null)] })
    }
    if (e.command !== undefined) {
      // A skill's text exists only once it expands: route it at skill.prompt, or at the first step.
      const name = e.command.name
      if (name !== 'router' && (await $.command.list()).some(c => c.name === name && (c.source === 'user' || c.source === 'plugin'))) {
        await update($, pending, () => e.text.trim())
      }
      return next(e)
    }
    const forced = FORCE.exec(e.text)
    if (forced !== null) {
      const tier = (forced[1] ?? 'opus').toLowerCase() as Tier
      await apply($, { tier, confidence: 1, source: 'forced', why: 'forced' }, cfg)
      return next({ ...e, text: e.text.slice(forced[0].length) })
    }
    await routePrompt($, e.text, cfg)
    return next(e)
  }).catch(($, e, next) => next(e)) // routing is best effort: never hold a prompt back

  // Some accounts (team/organization) have no skill.prompt; the first step routes the typed command then.
  try {
    on('skill.prompt', async ($, e, next) => {
      const typed = await read($, pending)
      if (typed !== null) {
        await update($, pending, () => null)
        await routePrompt($, `${typed}\n\n${e.text.slice(0, 2000)}`, cfg)
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  } catch {}

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      try {
        const baseline = await read($, sessionModel)
        if (workers.has(e.agentId) && result.usage !== null && baseline !== null) {
          const actual = usd(result.usage.model || e.model, result.usage, cfg.cache)
          const would = usd(baseline, result.usage, cfg.cache)
          if (actual !== undefined && would !== undefined) {
            await bill($, { routedSteps: 1, actualUsd: actual, baselineUsd: would })
          }
        }
      } catch {}
      return result
    }
    const typed = await read($, pending)
    if (typed !== null) {
      await update($, pending, () => null)
      if (words(typed) >= 3) {
        await routePrompt($, typed, cfg)
      }
    }
    await update($, steps, n => n + 1)

    let routed = e
    const chosen = await read($, route)
    if (chosen !== null) {
      // A /model by hand after routing wins for the rest of the session.
      const recorded = await read($, sessionModel)
      const model = await $.session.model()
      if (recorded !== null && model !== recorded) {
        await update($, isManual, () => true)
        await update($, route, () => null)
        $.ui.status('router: /model changed by hand, routing off (/router on resumes)')
        await log($, 'manual', { from: chosen.tier, to: model })
      } else {
        // The session's own id when it is already that tier, so a variant it chose (`[1m]`) is kept.
        routed = { ...e, model: tierOf(e.model) === chosen.tier ? e.model : chosen.model, effort: chosen.effort }
      }
    }

    const result = yield* next(routed)
    // Never throw from here: the request already ran.
    try {
      const u = result.usage
      if (u !== null) {
        const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
        const now = await $.clock.now()
        await update($, context, () => total)
        await update($, warm, w => ({ ...w, [cacheKey(routed.model)]: { tokens: total, at: now } }))
        if (routed.model !== e.model) {
          const actual = usd(u.model || routed.model, u, cfg.cache)
          const baseline = usd(e.model, u, cfg.cache)
          if (actual !== undefined && baseline !== undefined) {
            await bill($, { routedSteps: 1, actualUsd: actual, baselineUsd: baseline })
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
        if (e.usage !== undefined && e.reason === 'answer') {
          const all = await profiles($)
          await $.store.set('profile', { ...all, [r.tier]: learn(all[r.tier], await read($, steps), e.usage.output_tokens) })
        }
      }
      const text = await read($, note)
      if (cfg.showNote && text !== null) {
        return { ...done, text }
      }
    } catch {}
    return done
  })

  // A subagent that names no model takes the turn's cheaper tier. A complex turn leaves subagents on their own
  // default, and a fork inherits the parent, so both pass through.
  on('agent.spawn', async ($, e, next) => {
    const worker = cfg.mode === 'crew' && e.resume === undefined ? tierOfWorker(e.subagentType) : undefined
    if (worker !== undefined) {
      // One worker per model: a second would start with a cold cache. Point the model at the one that is warm.
      const live = (await $.agent.list()).find(a => a.type === e.subagentType && (a.status === 'idle' || a.status === 'running' || a.status === 'waiting' || a.status === 'pending'))
      if (live !== undefined) {
        return { deny: `${workerName(worker)} is already running as ${live.teammateId ?? live.id}: send it this task with SendMessage to that name, so it keeps its warm cache.` }
      }
      const started = await next({ ...e, model: MODEL[worker] })
      if (started.agentId !== undefined) {
        workers.add(started.agentId)
      }
      return started
    }
    const r = await read($, route)
    if (r === null || rank(r.tier) >= rank('opus') || e.subagentType === 'fork' || e.model !== undefined) {
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
        const failed = result.deny === undefined && result.isError === true
        const n = await update($, strikes, k => (failed || isRetry ? k + 1 : 0))
        const up = ORDER[rank(r.tier) + 1]
        if (n >= STRIKES && up !== undefined && (up !== 'fable' || cfg.enableFable) && !(await read($, hasEscalated))) {
          await update($, hasEscalated, () => true)
          const reason = failed ? 'tools keep failing' : 'going in circles'
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
          await log($, 'escalate', { from: r.tier, to: up, reason, taken: cfg.escalate === 'auto' })
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

  // /clear empties the conversation and a compaction replaces it: no model's cache holds it any more.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, route, () => null)
      await update($, context, () => 0)
      await update($, warm, () => ({}))
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    await update($, warm, () => ({}))
    return done
  })

  // Output economy: one section at the end of the system prompt, inside the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) {
      return composed
    }
    const added = []
    const text = STYLE[(await read($, style)) ?? cfg.style]
    if (text !== undefined) {
      added.push({ id: 'model-router:style', text, scope: 'session' as const })
    }
    if (cfg.mode === 'crew' && !e.traits.includes('teammate')) {
      added.push({ id: 'model-router:crew', text: crewSection(cfg.orchestrator, WORKERS), scope: 'session' as const })
    }
    return added.length === 0 ? composed : { sections: [...composed.sections, ...added] }
  })
}
