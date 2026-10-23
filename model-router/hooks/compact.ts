import type { EngineInterface, ModelUsage, SessionCompactResult, SessionMessage } from 'claude-code'

// One Haiku request reads at most this much transcript (~100k tokens); a longer
// one is summarized in order, each request carrying the summary so far.
const CHUNK_CHARS = 400_000
const TOOL_INPUT_CHARS = 2_000
const TOOL_TEXT_CHARS = 4_000
const SUMMARY_MAX_TOKENS = 8_000
const CALL_TIMEOUT_MS = 5 * 60_000

const SYSTEM = `You compress the transcript of a coding-agent session so the agent can continue the work from your summary alone, without the original transcript.

Write a dense, factual summary with these sections:
1. User's requests and intent: every explicit request, in order, and what the user wants overall.
2. User's corrections and preferences: anything the user told the agent to do differently, verbatim where short.
3. Key technical context: languages, frameworks, services, hosts, commands that matter.
4. Files and code: every file path read or changed, what changed and why; include short code snippets that later work depends on.
5. Errors and fixes: what broke, the cause, and how it was fixed.
6. Decisions made and open questions.
7. Current state: what was being worked on in the latest messages, exactly where it stopped.
8. Next step: the immediate next action, only if the transcript makes it clear.

Keep exact file paths, identifiers, commands, URLs, versions and numbers. Do not invent anything that is not in the transcript. No preamble.`

const HEADER = 'The earlier conversation was compacted into this summary (written by a smaller model). The most recent messages follow it word for word.\n\n'

const ZERO: ModelUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars cut]`)

const isPrompt = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== ''

/** The transcript as plain text; tool results are read from the assistant's tool calls. */
export function renderTranscript(messages: readonly SessionMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.text.trim()) parts.push(`## User\n${m.text}`)
      continue
    }
    const lines = m.text.trim() ? [m.text] : []
    for (const use of m.toolUses) {
      lines.push(`→ ${use.tool} ${clip(JSON.stringify(use.input), TOOL_INPUT_CHARS)}`)
      if (use.text !== undefined) lines.push(`  ⇒ ${use.isError ? 'ERROR ' : ''}${clip(use.text, TOOL_TEXT_CHARS)}`)
    }
    if (lines.length) parts.push(`## Assistant\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

/** Pieces of at most `max` chars, cut at a message boundary where one is near. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n\n## ', max)
    const at = cut > max / 2 ? cut : max
    out.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest) out.push(rest)
  return out
}

/** Where the kept tail starts: the earliest typed prompt among the last `keep` messages. */
export function keepFrom(messages: readonly SessionMessage[], keep: number): number {
  for (let i = Math.max(0, messages.length - keep); i < messages.length; i++) {
    if (isPrompt(messages[i]!)) return i
  }
  return messages.length
}

/** A rough token count of a transcript: about four characters a token. */
export function estimateTokens(messages: readonly SessionMessage[]): number {
  return Math.round(messages.reduce((n, m) => n + m.text.length + JSON.stringify(m.toolUses).length, 0) / 4)
}

const addUsage = (a: ModelUsage, b: ModelUsage): ModelUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
})

/**
 * Summarizes the older messages with `model` and returns the compacted
 * conversation: a summary header, then the last `keep` messages verbatim.
 * `{ skip }` when there is nothing to summarize or the model failed — the
 * caller must not fall through to an expensive-model compaction then.
 */
export async function summarize($: EngineInterface, model: string, messages: readonly SessionMessage[], keep: number, notes?: string): Promise<SessionCompactResult> {
  const from = keepFrom(messages, keep)
  const older = messages.slice(0, from)
  if (older.length === 0) return { skip: 'nothing older than the kept messages to summarize' }
  const system = notes ? `${SYSTEM}\n\nThe user asks the summary to keep or stress: ${notes}` : SYSTEM
  let summary = ''
  let usage = ZERO
  for (const piece of chunk(renderTranscript(older), CHUNK_CHARS)) {
    const prompt = summary
      ? `Summary of the transcript so far:\n\n${summary}\n\nThe transcript continues below. Rewrite the summary so it covers everything.\n\n${piece}`
      : `Transcript:\n\n${piece}`
    const r = await $.model.complete({ model, system, prompt, maxTokens: SUMMARY_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS })
    usage = addUsage(usage, r.usage)
    if (!r.isAnswered) return { skip: `${model} could not summarize (${r.reason})` }
    summary = r.text
  }
  return {
    messages: [{ role: 'user', text: HEADER + summary, toolUses: [] }, ...messages.slice(from)],
    usage,
  }
}
