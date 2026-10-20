![model-router](.github/header.svg)

<p align="center">
  <a href="https://github.com/preisnerai/claude-mods/actions/workflows/test.yml"><img src="https://github.com/preisnerai/claude-mods/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-mod-8a63d2" alt="Claude Code mod">
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
</p>

<p align="center"><b>English</b> · <a href="README.pl.md">Polski</a></p>

**model-router** is a Claude Code mod that cuts what a session costs in three places at once:

| | What it does | Where the tokens go |
|---|---|---|
| 🔀 **Route** | Sends each prompt to Haiku, Sonnet or Opus by what it needs. Local rules in English and Polish call clear prompts with no model call; only unclear ones go to a Haiku judge (about $0.0001 each). | Fewer Opus tokens |
| 🧮 **Do the cache math** | Changing model throws away the prompt cache: the next request re-reads the whole conversation at write price. Before every move to a cheaper model the router prices the turn on both models with your actual context size and cache state, and moves only when it pays. | No downgrade costs more than it saves |
| 🗜️ **Compress** | Bash output shrinks before it enters the conversation, rtk-style: no progress bars or passing tests, exact repeats folded into a count, every error kept. File contents, diffs and data pass untouched. The full output is kept on disk. With [rtk](https://github.com/rtk-ai/rtk) installed, the test and type-check runs it parses go through `rtk pipe`. | Less input on every later request |
| ✂️ **Speak less** | One short system-prompt section asks for no preamble, recaps or closers, and for batched commands and partial file reads. `adhd` mode puts the next action first, after [i-have-adhd](https://github.com/ayghri/i-have-adhd). | Fewer output tokens, which cost 5× input |

`/router` shows what routing saved in dollars and how many tokens compression kept out of the context, for this session and all time.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install model-router --marketplace preisnerai/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. That's it: no server, no binary, no API key. From a shell: `claude plugin install model-router --marketplace preisnerai/claude-mods`. In the desktop app: **+** next to the prompt box → Plugins → Add marketplace `preisnerai/claude-mods` → Add plugin.

## Why cache-aware routing matters

A router that switches models on every prompt can **cost** you money. Claude's prompt cache belongs to one model: switch, and the next request pays the cache-write price for the whole conversation: 2× input, for the 1-hour entries Claude Code writes. Its system prompt and tools alone run to tens of thousands of tokens, so even a young session has something to lose.

These are the router's own numbers, for a session on Claude Opus 5.5 with a warm cache:

| Context already cached | Opus → Sonnet for a routine task | Opus → Haiku for a quick task |
|---:|---|---|
| 40k tokens | **stays on Opus**: a draw (+$0.002) | **switches**: saves $0.047 |
| 100k tokens | **stays on Opus**: switching costs $0.23 more | **switches**: saves $0.051 |
| 150k tokens | **stays on Opus**: switching costs $0.42 more | **stays on Opus**: Haiku's long-context rate makes it $0.063 more |
| 400k tokens | **stays on Opus**: switching costs $1.37 more | **stays on Opus**: $0.23 more |

Opus 5.5 and Sonnet 5.5 read cache at the same $0.20/MTok, so mid-session Sonnet saves only on output, and writing the conversation into its cache costs more than that. Haiku 5.5 is 40× cheaper than Opus on input up to 100K tokens, so dropping to it pays even after the rewrite; past 100K it bills a long-context rate five times higher, and a warm Opus is cheaper again. When a model's cache has lapsed (an hour idle), both sides pay the write and the cheaper model wins. Going back to a model whose cache is still warm costs only what changed since. The cache also belongs to the request's effort, so on your own model the router keeps your `/effort` and never rebuilds the cache by changing it.

Harder tasks are about quality, not money: by default the router moves up a tier when a prompt needs it, and shows what the switch cost with the cache re-write. Set `escalate: suggest` to only name the tier in the status line and decide yourself. A `!tier` prefix always switches.

The turn shape behind those numbers (requests per turn, tokens written, how much each request adds to the context) starts from priors per tier and learns from your own finished turns, filed under the tier of the task.

## How a prompt is routed

```mermaid
flowchart LR
    P[prompt] --> F{"!opus prefix?"}
    F -- yes --> T[that tier]
    F -- no --> U{"short follow-up<br/>(ok, dalej, do it)?"}
    U -- yes --> K[keep current model]
    U -- no --> R{"local rules<br/>EN + PL, 0 tokens"}
    R -- clear --> E
    R -- unclear --> J["laya-serve (optional)<br/>or Haiku judge"]
    J --> E{"cache math:<br/>cheaper tier pays?"}
    E -- yes --> S[switch]
    E -- no --> K
```

- **Overrides:** start a prompt with `!haiku`, `!sonnet`, `!opus` (or `!fable`) to force it. The prefix is removed before the model sees the prompt, also while routing is off.
- **Follow-ups** ("ok", "dalej", "do it", or three words the rules don't read) keep the current model. A short prompt the rules do read ("debug flaky test") is routed like any other.
- **`/model` wins:** change the model by hand and routing stops for the session. `/router on` resumes.
- **Stuck detection:** three failed or identical tool calls in a row move the turn up one tier (or suggest it).
- **Subagents:** a general-purpose subagent that names no model gets the turn's cheaper tier. Other agent types may pin a model in their definition, so they, forks and Opus turns are left alone.
- **Skills** (`/my-skill args`) are routed by what you typed and the command's own description, not by the skill's instructions. Claude Code's own prompt commands (`/code-review`, `/security-review`, `/init`) and MCP prompts run on your `/model`.
- **Prompts typed during a turn** are routed when their own turn starts.
- **Effort** follows the tier when the router moves you to another model: Haiku `low`, Sonnet `medium`, Opus `high`, Fable `xhigh`, each configurable. On your own model the request keeps your `/effort`.
- **The engine's own fallback** (a refusal or an overload switching the model) pauses routing until the next prompt and does not count as a manual `/model`.

## Crew mode: one orchestrator, three warm workers

Set `mode: crew` and the main session stays on one orchestrator model (Sonnet by default). It moves there once, at the first prompt, and never again, so its prompt cache is never thrown away. Work that takes several tool calls goes to long-lived workers:

| Worker | Model | Gets |
|---|---|---|
| `worker-haiku` | Haiku 5.5 | searching and reading code, summaries, running commands, mechanical edits |
| `worker-sonnet` | Sonnet 5.5 | clear features and fixes, tests, refactors |
| `worker-opus` | Opus 5.5 | unclear bugs, architecture, security and performance analysis |

Each worker keeps its context between tasks: after its first task the orchestrator sends it the next one with `SendMessage` (a finished worker resumes where it was). Workers do the task themselves (they cannot start agents) and answer with a report of at most 10 lines: paths with line numbers, the command that checks it, what is open. The orchestrator is told to name files rather than paste them into a hand-off, never to read a worker's output file, and to do work of two tool calls or less itself, since a hand-off and a report cost two of its own requests.

- The local rules still read every prompt. One that needs a **stronger** model than the orchestrator reaches it with a one-line hint to hand it over if it takes three or more tool calls. `!haiku …` / `!opus …` delegate the whole prompt; `!fable …` goes to `worker-opus`, as there is no Fable worker.
- If the model starts a second worker of the same model, the mod refuses and names the one to message, unless the old worker's context has grown or gone cold enough that a fresh one is cheaper. A spawn under another name (`worker-opus-2`) always gets past a worker that stopped answering.
- `/router off` turns crew off for the session: no crew section, no spawn checks.
- `/router` counts each worker request against the same request on your own `/model`.

Tested live: two tasks for `worker-haiku` in one session started one worker, reused it through `SendMessage`, and cost $0.0023 in Haiku tokens.

## Bash output compression

| Output | What the model gets |
|---|---|
| `npm test` with 400 passing tests and 1 failure | the failure with its diff, the summary, `(400 passing test lines hidden)`: over 10× smaller |
| `pnpm install`, `docker build`, `pip install` | progress bars and spinners gone, repeated warnings as one line `(×30)` |
| `git push`, `git clone` | no `Counting/Compressing objects` lines |
| a 2,000-line log | its head, its tail, and the error lines from the middle with the two lines after each (their location), up to 200 lines |
| `cat`, `sed -n`, `head`, `grep`/`rg`, `git diff`/`show`/`log -p` (any spelling: `git -C dir`, `--no-pager`, `/bin/cat`, `bash -c`, `xargs cat`), `jq`, `curl`, `docker inspect`, `kubectl get` | **untouched**: file contents, diffs and data the model may quote back into an edit |

Claude Code itself moves very large outputs to a file and shows a 2 KB preview; model-router works on the mid-size ones below that, which otherwise enter the context whole: typical test runs, installs and builds.

Rules it never breaks: lines carrying an error are never dropped, folded or shortened; lines that only look alike are folded only in install and build logs; output under 1,200 characters is left alone; a result that would shrink by less than 10% once its note is added is passed through unchanged; and whatever a result no longer shows is saved whole under `~/.claude/model-router/tee/` (a ring of the last 200 compressed outputs), with the path in the output so the model can `grep` it.

With [rtk](https://github.com/rtk-ai/rtk) on your PATH, plain `cargo test`, `pytest`, `tsc`, `mypy` and `go build` runs go through `rtk pipe` instead (not `--collect-only`, `--showConfig`, `--help` and other modes that print something else). An rtk summary that drops the failures the output shows is refused. Nothing is rewritten, so your permission rules see the command you approved.

## Answer styles

`terse` (default) adds one short section to the end of the system prompt: lead with the answer, no preamble or recap or closing offer, don't echo code back, batch shell commands, read the part of a file you need. It never shortens an explanation you asked for, and confirmations before destructive actions stay.

`adhd` shapes answers for a reader with ADHD, adapted from [i-have-adhd](https://github.com/ayghri/i-have-adhd): next action first, numbered steps, one concrete next step, state restated each turn, real time estimates.

`off` leaves the system prompt alone. Switch with `/router style terse|adhd|off`. A change rewrites the system prompt once, so that one request re-reads the conversation uncached.

## Commands

| | |
|---|---|
| `/router` | route in force, savings this session and all time, switches vs. holds, compression totals |
| `/router style terse\|adhd\|off` | answer style for this session |
| `/router off` · `/router on` | stop or resume routing (or crew) for this session |
| `/router log` | the last 50 routing decisions as JSON lines, for tuning |
| `/router reset` | clear all-time totals, learned turn profiles and the log |

The status line shows each decision (`router: Sonnet·medium (rule .86) · saved ≈$0.41`), and a note beneath each answer names the model and why, for surfaces with no status line.

## Settings

Shown when you install, and later under `/config`:

| Setting | Default | |
|---|---|---|
| `mode` | `route` | `crew`: orchestrator plus warm workers, no model switches |
| `orchestrator` | `sonnet` | the main session's model in crew mode |
| `escalate` | `auto` | `suggest`: only name a harder tier in the status line |
| `style` | `terse` | `adhd`, `off` |
| `compress` | `true` | Bash output compression |
| `useRtk` | `true` | use `rtk pipe` when the rtk binary is installed |
| `cacheTtl` | `1h` | `5m` if your setup writes 5-minute cache entries (1.25× instead of 2×) |
| `judge` | `haiku` | `off`: no Haiku judge; unclear prompts go to laya-serve when `layaUrl` is set, and otherwise keep the current model |
| `layaUrl` | empty | a running [laya-serve](https://github.com/NandhaKishorM/laya) classifies unclear prompts locally, before the judge |
| `layaApiKey` | empty | sent to laya-serve as a Bearer token |
| `enableFable` | `false` | route proofs and new theories to Claude Fable 5.1 |
| `haikuEffort` … `fableEffort` | `low` `medium` `high` `xhigh` | effort per tier, when the router moves you to that model (on your own model your `/effort` stays) |
| `showNote` | `true` | the line beneath each answer |

Model ids per tier are at the top of [`model-router/hooks/register.ts`](model-router/hooks/register.ts). On Bedrock or Vertex, put your provider's ids there.

## FAQ

**Is the "saved" figure real?** It is an estimate at list prices, and it covers routing only (compression is reported in tokens kept out of the context, and the shorter answers are not measured). Every main-loop request is priced twice: as it ran, and as it would have run on your own `/model` with that model's own cache, as if every request had gone there. So a switch's cache write counts against the savings, and so does re-warming your model after a routed stretch. The judge's cost is subtracted too. Crew workers are compared with the same requests on your `/model`. Subscription plans don't bill per token, but the same tokens count against your usage limits.

**Does compression break the prompt cache?** No. Output is shrunk once, before it is stored, so every later request sends the same small text and caches it normally.

**Does the style section break the cache?** It is added once at session start and stays the same, so it is cached with the rest of the system prompt. Only changing the style mid-session costs one uncached request.

**What about privacy?** Routing and compression run inside Claude Code. The only requests the mod makes are the Haiku judge on your own account (for unclear prompts, unless `judge: off`) and laya-serve if you set it up. It also runs `rtk` locally when installed, and keeps the last 200 full Bash outputs under `~/.claude/model-router/tee/`.

## More mods in this repo

**[find-mod](find-mod)** (0.1, early): finds Claude Code mods on GitHub. `/find-mod what you need` searches the `claude-mod`, `claude-code-mod` and `claude-code-plugin` topics, has Haiku rate each match, and picks the best match with the most stars. `/find-mod install owner/repo` previews first and installs only with `--yes`. Install it with `/plugin install find-mod --marketplace preisnerai/claude-mods`. Details in [Polish](README.pl.md#find-mod).

To make your own mod findable: add the `claude-mod` topic and a `.claude-plugin/marketplace.json` to its repository.

## Credits

- [laya-router](https://github.com/marcreichel/laya-router) by Marc Reichel (MIT): the idea of routing on a classifier and the cost of switching mid-session, `/model` taking precedence, stuck detection, the calibration log, and the laya-serve tier descriptions this mod reuses.
- [rtk](https://github.com/rtk-ai/rtk) by rtk-ai: the output-compression strategies reimplemented here, and the binary this mod calls when it is installed. No rtk code is included.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd) by Ayoub Ghriss (MIT): the rules behind the `adhd` style.

## Develop

```bash
claude plugin validate model-router
claude plugin test model-router      # 87 tests: rules, cost model, compression, routing and crew end to end
claude --plugin-dir model-router     # try it in a session
```

## License

[MIT](LICENSE)
