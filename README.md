# Agent Memory Gate

**Memory selection without a salience model: observed repetition and a deterministic budget are the only gates.**

An agent-memory system for coding agents that decides *what deserves to be a memory* without asking an LLM. Knowledge is promoted only when the agent's own observed behavior repeats it; every paid LLM call sits behind a deterministic budget ledger; the result is a per-project briefing a fresh session reads unprompted.

This repo is a clean export of a working research system: the full deterministic pipeline (122 tests), the eight-run evaluation series with its null results, and a measured comparison against A-MEM (NeurIPS 2025) on identical input.

---

## The claim, in one table

Every major memory system decides what to remember with an LLM call at write time:

| System | Salience decision | Write cost per item |
|---|---|---|
| MemGPT / Letta | LLM-managed memory hierarchy, runtime paging | LLM tokens per interaction |
| Mem0 | LLM extraction + consolidation (ADD/UPDATE/DELETE) | LLM call per extraction |
| Zep / Graphiti | LLM entity/edge extraction at ingest | LLM call per ingest |
| LangMem | Developer-defined extraction (hot-path or background) | LLM per extraction pass |
| A-MEM | Store everything; LLM generates attributes/links/evolution | ~1.2k tokens/note (paper) |
| **Agent Memory Gate** | **None. Repetition ≥2 across sessions + budget gate** | **$0 on one-pass work; deterministic otherwise** |

The falsifiable question this repo tests: *can behavior-derived salience match LLM-judged salience for procedural memory, at orders of magnitude lower write cost — and where does it fail?*

## Measured results

### Run 08: vs A-MEM (NeurIPS 2025) on identical input — cost and recall

12 session-summary notes ingested by both systems; 7 ground-truth-scored probes (case-insensitive regex, identical criteria for both arms). Same LLM (GLM-5.3) for both systems' quality-relevant calls.

| Metric | A-MEM (as shipped) | Agent Memory Gate |
|---|---|---|
| LLM write calls | **11** | **0** (capture + gating are deterministic) |
| Write tokens | **13,147** (9,869p + 3,278c; 1,095.6/note steady state) | **0** |
| Probe recall | **7/7** (all 7 answers at top-1) | **5/7** (5/5 on content its pipeline had captured) |
| Ingest wall time | ~30s | <1s |

Verdict: **A-MEM won recall on fresh ingestion — 7/7 with every answer at top-1 — while the gate held 5/5 on what it had captured, at zero write cost.** The gate's two misses are content its pipeline structurally cannot hold (same-day results that never repeated) — that's the starvation trade, measured, not spun. Cost: 13,147 paid tokens vs 0. See [`experiments/run-08-a-mem-baseline.md`](experiments/run-08-a-mem-baseline.md), raw data in [`experiments/run-08-data/`](experiments/run-08-data/).

Notable implementation finding: A-MEM's shipped repo never calls its attribute-generation LLM (`analyze_content` is dead code in the current HEAD), so the measured cost is a *lower bound* of the paper-faithful pipeline.

### Runs 01–07: the honest evaluation series

Nine paired fresh-agent sessions plus a full-loop realistic test, comparing memory-equipped vs bare sessions on real coding tasks:

| Claim | Verdict | Evidence |
|---|---|---|
| Briefing saves input tokens | **Yes — 10–29%, consistent** | runs 01–04 (9 pairs) + run-07 |
| Briefing improves discipline | **Yes — small but clean** | offline/ignore-scripts compliance 3/3 vs 0/3; suite-wired test runs; no false greens |
| Briefing changes correctness on repo-derivable tasks | **No** | methods converged in every run — smart agents re-derive |
| Stale/dead memory gets followed | **No — survived a baited trap** | run-04: 0 stale commands in 6 runs |
| Full loop works on realistic work | **Yes** | run-07: −29% uncached input, correctness tie |

Full series with per-run protocols and raw numbers: [`experiments/first-memory-eval.md`](experiments/first-memory-eval.md).

### The honest failure mode (why this is research, not a product pitch)

**The repetition gate starves on one-pass competent work.** A session that solves its task in one pass produces nothing that repeats, so the gate promotes nothing — measured externally in run 08: the 4 one-pass notes cost A-MEM 5,611 tokens to ingest and were fully retrievable; the gate holds none of them by design. Fixing this without reintroducing LLM-judged salience (satisfaction-transition markers as promotion evidence is the candidate) is the open question.

## How it works

```
sessions ──▶ capture (deterministic: rollout readers, usage ledger)
                 │
                 ▼
        repetition gate ──── ≥2 repeats across sessions ───▶ paid review (budget-gated)
                 │                                                 │
                 └─── 1 repeat ──▶ nothing (free)                  ▼
                                                          candidate records
                 satisfaction markers ─────────────────────────────▶ HISTORY
                                                                    │
                                                                    ▼
                                              .project-memory/ BRIEFING.md + HISTORY.md
                                                                    │
                                                                    ▼
                                              next session reads it unprompted (AGENTS.md wiring)
```

Key properties:

- **Repetition-as-importance.** A procedure is promoted only when the usage ledger observes the same non-trivial work ≥2 times across sessions (flow-token exclusion, normalized command keys). Cognitive grounding: rehearsal-based consolidation. Cost: $0.
- **Budget-gated paid inference.** Every LLM call reserves from a SQLite-backed budget ledger with atomic reservation and ambiguous-failure holds; the cap fails closed. The whole evaluation series ran on ~$10 of paid inference.
- **Provenance-mandatory records.** Every memory carries its source session; supersession never deletes (Zep-style temporal invalidation, no graph required).
- **Redaction gate.** Secret-shaped content (API key patterns, credential assignments) is excluded before any paid call sees it — fail-closed.
- **Briefing, not chat history.** The deliverable is two markdown files the next agent reads at session start; consumption was verified unprompted in runs 05–07.

Deep dive: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) · architecture: [`docs/architecture.html`](docs/architecture.html) · positioning vs related systems: [`docs/lit-positioning.md`](docs/lit-positioning.md)

## Running it

Requires [Bun](https://bun.sh) (SQLite + TypeScript runner) and Node for the eval tooling.

```bash
bun install
bun scripts/test.ts          # full suite: 122 tests
```

Pipeline entry points (each is a standalone script, no server, no database service):

```bash
bun scripts/session-capture.ts          # capture Codex rollouts -> usage ledger + candidates
bun scripts/queue-review.ts             # paid review of repetition-gated candidates (budget-gated)
bun scripts/session-start.ts <dir>      # render <dir>/.project-memory/BRIEFING.md + HISTORY.md
```

The memory lives in plain files; the ledgers are SQLite; there is no infrastructure.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | The deterministic pipeline: 22 modules (rollout readers, usage ledger, redaction gate, budget ledger, reviewer client, satisfaction classifier, renderers) |
| `test/` | 122 tests covering every invariant; canonical runner `scripts/test.ts` |
| `evidence/` | Test-suite execution logs (the final green runs) |
| `experiments/` | Run protocols + results for the full evaluation series and the A-MEM comparison, with raw JSON |
| `docs/` | How-it-works, architecture, literature positioning |
| `schema/` | The record contract (7 kinds, proposed/tentative ceiling, immutable creates) |

## Honest limitations

1. **n is small.** 9 eval pairs + 1 comparison corpus. This is one honest point on the curve, not a leaderboard claim.
2. **No embeddings.** Retrieval is per-project briefing files; scaling behavior past one project is unmeasured.
3. **The starvation problem is unsolved.** Single-pass sessions contribute no procedures; the satisfaction-marker lane is proposed, not yet evaluated as a promotion signal.
4. **Codex + Hermes rollouts only.** The capture readers handle two session formats; others are untested.
5. **Eval scoring used string-presence ground truth**, deterministic and reproducible but coarse; no LLM-judge.

## License & provenance

MIT. This is a clean public export of a private research repo (source commit recorded in `SOURCE_COMMIT.txt`): personal paths rewritten to `~/`, private session-derived data excluded. Every number in this README is machine-checked against the raw result files by the evidence tests in the companion repo of run-08.

## Citation-worthy framing

If you build on this, the comparison to replicate is: *deterministic repetition-gating vs LLM-judged salience on identical procedural corpora, measuring write-path cost and ground-truth probe recall.* The open question worth pursuing: *can a second behavioral signal (user satisfaction transitions) close the one-pass starvation gap without reintroducing per-write LLM cost?*
