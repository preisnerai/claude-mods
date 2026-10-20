import type { Tier } from '../types'

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
  haiku: 'searching and reading code, summarizing files or logs, running commands and reporting what they print, mechanical edits with exact instructions.',
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
- If the task is ambiguous or blocked, say in one line what is missing.
- Keep what you learned for the next task. Batch shell commands; read only the part of a file you need.`

/** The orchestrator's standing instructions: one section at the end of the main system prompt. */
export function crewSection(orchestrator: Tier, enabled: readonly Tier[], canMessage: boolean): string {
  const rows = enabled.map(t => `- ${workerName(t)} (subagent_type "${workerType(t)}"): ${WHEN[t]}`).join('\n')
  const reuse = canMessage
    ? '- First task: the Agent tool with that subagent_type and name. Later tasks: SendMessage to the name. If the mod refuses a spawn, do what its message says.'
    : '- Start a worker with the Agent tool, with that subagent_type and name.'
  return `# Crew (model-router)
You orchestrate on ${orchestrator}. Each of your requests re-reads this whole conversation, and a delegation costs you two of them (the hand-off, then the report).
Do it yourself when it takes at most two tool calls or needs only this conversation: questions, decisions, short edits, translating or rewriting text given here.
Delegate when it takes three or more tool calls, many files or long command output:
${rows}
${reuse}
- Hand-off: goal, file paths with line ranges, constraints, what "done" means. Name files, never paste them: your output costs more than the worker's reads.
- Wait for the report; never read or poll a worker's output file. Trust it: open a file only to settle what it leaves open.
- Independent tasks for different workers go out in one message. Answer the user in a few lines without repeating the report.`
}

/**
 * A line the orchestrator reads beside a prompt that a worker should take. Forced (`!opus …`): hand it all over.
 * Otherwise only for a harder tier than the orchestrator's, and only when the task is tool-heavy: below that,
 * a hand-off and a report cost more than doing it.
 */
export function delegationHint(tier: Tier, isForced: boolean, live: string | undefined): string {
  const name = workerName(tier)
  const how = live !== undefined ? `SendMessage to "${live}"` : `Agent tool, subagent_type "${workerType(tier)}", name "${name}"`
  return isForced
    ? `[model-router] The user chose ${tier} for this task: hand all of it to ${name} (${how}), then relay its report in a few lines.`
    : `[model-router] ${tier}-level task: if it takes three or more tool calls, hand it to ${name} (${how}); otherwise do it yourself.`
}
