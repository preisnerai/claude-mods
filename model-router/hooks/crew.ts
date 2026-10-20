import type { Tier } from '../types'

// Crew mode: the main session stays on one model (the orchestrator) so its prompt cache never resets, and work
// goes to long-lived workers, one per model. A worker is a teammate: it idles between tasks with its own cache
// warm, takes the next task by message, and answers with a short report instead of its whole transcript.

export const WORKERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export function workerName(tier: Tier): string {
  return `worker-${tier}`
}

/** The full agent type, as the Agent tool and `agent.spawn` spell it. */
export function workerType(tier: Tier): string {
  return `model-router:${workerName(tier)}`
}

export function tierOfWorker(subagentType: string): Tier | undefined {
  return WORKERS.find(t => subagentType === workerType(t) || subagentType === workerName(t))
}

const WHEN: Record<Tier, string> = {
  haiku: 'Cheap, fast worker: searching and reading code, summarizing files or logs, running commands and reporting what they print, mechanical edits with exact instructions, translations, formatting.',
  sonnet: 'Routine worker: implementing a clear feature or fix across a few files, writing tests, refactors with a clear target, scripts and queries.',
  opus: 'Strongest worker: unclear failures to debug, architecture and design, security or performance analysis, multi-file refactors, plans.',
  fable: 'Research worker: proofs, new theories, bounds.',
}

export function workerSpec(tier: Tier, model: string, effort: string) {
  return {
    name: workerName(tier),
    description: `${WHEN[tier]} Long-lived: after its first task, send it the next one with SendMessage instead of spawning another.`,
    prompt: WORKER_PROMPT,
    model,
    effort,
  }
}

const WORKER_PROMPT = `You are a worker in a crew of Claude models. An orchestrator sends you tasks; you do them with your tools and report back.

- Each message is a task. It carries the context you need; read files yourself rather than asking for them.
- Do the task completely, then reply with a short report: what you did or found, file paths with line numbers, the exact commands that matter, and anything still open. At most 15 lines unless the task asks for full text.
- Do not paste whole files, long logs or diffs into the report: point to where they are. The orchestrator pays for every token it reads.
- Keep what you learned: the next task may build on it.
- If the task is ambiguous or blocked, say exactly what is missing in one line instead of guessing.
- Batch related shell commands into one call, and read the part of a file you need rather than all of it.`

/** The orchestrator's standing instructions: one section at the end of the main system prompt. */
export function crewSection(orchestrator: Tier, enabled: readonly Tier[]): string {
  const rows = enabled.map(t => `- \`${workerType(t)}\` (name it \`${workerName(t)}\`): ${WHEN[t]}`).join('\n')
  return `# Crew (model-router)
You are the orchestrator, running on ${orchestrator}. Your context is the expensive one, so keep it small: delegate work that can be described on its own, and keep for yourself what depends on this conversation (clarifying intent, decisions, short answers).
Workers, each a long-lived teammate with its own warm cache:
${rows}
- Start a worker with the Agent tool, using its type and its name. After that, give it new tasks with SendMessage to that name: never spawn a second worker of the same type.
- Put everything a worker needs in the task: goal, files, constraints, what "done" means. It does not see this conversation.
- Prefer the cheapest worker that can do the task; use opus only for the hard parts.
- Work that is independent goes to several workers at once. Read their reports, decide, and answer the user briefly.`
}

/** A hint the orchestrator reads beside a prompt that a worker should take. */
export function delegationHint(tier: Tier, isForced: boolean): string {
  return isForced
    ? `[model-router] The user asked for ${tier}: delegate this whole task to ${workerName(tier)} (SendMessage if it is running, else the Agent tool with type ${workerType(tier)}).`
    : `[model-router] This reads as a ${tier}-level task: consider delegating it to ${workerName(tier)}.`
}
