# model-router

Cache-aware model routing, rtk-style Bash output compression and terse answers for Claude Code. Full documentation: [the repository README](../README.md) ([po polsku](../README.pl.md)).

```
/plugin marketplace add preisnerai/claude-mods
/plugin install model-router@claude-mods
```

## Layout

| File | |
|---|---|
| `hooks/register.tsx` | the hooks: routing at `prompt.submit` / `skill.prompt` / `turn.step`, `!+`/`!-`, accounting, `/router`, `/router-cache`, `/router-budget`, `/router-help`, `/router-start`, `/router-why`, `/router-effort` and the other aliases, escalation at `tool.call`, compression at `session.append`, the style section at `prompt.compose`; model ids per tier at the top |
| `hooks/classify.ts` | local EN/PL rules (code, non-code, simple git), negations and size signals, research → Sonnet policy, dissatisfaction, follow-up detection, the Haiku judge's rubric, the laya-serve question |
| `hooks/adapt.ts` | effort per task (never `max` or `ultracode`), the Desktop effort labels, the ultracode check, the learned per-category bias |
| `hooks/why.ts` | turns the last decision entry into the `/router why` explanation |
| `hooks/cost.ts` | list prices, cache-aware turn cost, switch economics, the savings and cache-hit ledger |
| `hooks/compress.ts` | rtk-lite: command families, noise and passing-test filters, folding, cutting, `rtk pipe` filters |
| `hooks/crew.ts` | crew mode: worker definitions, the orchestrator's section, delegation hints |
| `hooks/style.ts` | the `terse` and `adhd` system-prompt sections |
| `types/index.d.ts` | the `$.state` contract |
| `tests/` | `claude plugin test .`; `classify.test.ts` holds the labelled prompt corpus (≥85% target), `why.test.ts` the explanations, `adapt.test.ts` effort and learning |

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

Prices in `hooks/cost.ts` are Anthropic's first-party list prices of October 2026; update them when they change. After touching the rules in `hooks/classify.ts`, run the tests: `tests/classify.test.ts` holds the prompt set they are scored against. Every decision is mirrored to `~/.claude/model-router/decisions.json`; copy a misrouted prompt or effort from there into the corpus with the tier it should have had.
