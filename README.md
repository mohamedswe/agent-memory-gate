# Agent Memory Gate

**Behavior-Gated Memory for Coding Agents: Repetition, Satisfaction Transitions and Budget Ledgers**

`agent-memory-gate` is an experimental memory architecture for autonomous coding agents in which **behavioral evidence, not an LLM's judgment of importance, decides what is eligible to be remembered.** It has two capture lanes:

- **Procedures lane (`BRIEFING.md`):** a candidate is admitted to paid LLM review only after deterministic repetition is observed: the same normalized key repeated $\ge 2$ times within a session, or seen in $\ge 2$ distinct sessions of the same project. In this lane, a key seen only once never reaches a model.
- **History lane (`HISTORY.md`):** one batched, paid LLM call per session labels each user turn's satisfaction state; deterministic code then extracts milestone / recovery / regression / unresolved transitions, which are reviewed before becoming records.
- **Environment-feedback lane (headless runs):** with no user in the loop, the same idea is applied to commands instead: a command fails and later succeeds (`src/env-feedback.ts`). Arcs are classified deterministically (wrong invocation, tooling error fixed, unresolved, or ordinary red→green test loop, which is never stored). No model call.

All paid calls sit behind a fail-closed SQLite budget ledger. Memory is rendered as two static per-project Markdown files read at session start.

> **Status (2026-10-18):** this README was revised to correct several overstated claims in the original release. See [Corrections](#corrections-2026-10-18). The evidence so far supports *mechanism viability* on a small private corpus, not a general performance claim.

This repository contains the ingestion and gating pipeline (24 modules, 133 unit and invariant tests), evaluation notes for an eight-run pilot series (including null results), and a small comparison against A-MEM.

---

## Why I built this

While working with coding agents, I noticed that the parts of a conversation that actually matter tend to come up again. The commands, fixes, and procedures worth remembering get repeated across sessions; one-off details don't. That suggested repetition could serve as a free signal for what to remember, with no model call needed to decide.

The second motivation is context. Models are highly capable, but giving them less, more relevant information both cuts cost and avoids filling the context window with material that degrades their work. A short per-project briefing built only from repeated behavior aims to do exactly that.

## How it was built

The core idea, repetition as the signal for what to remember, is mine. Most of the code was written by AI coding agents working under my direction.

---

## Research Question & Related Work

Current agent memory architectures rely on LLM inference during the write path to determine salience, extract entities, or manage state updates:

| System | Salience & Extraction Mechanism | Write-Path Compute Cost |
| :--- | :--- | :--- |
| **MemGPT / Letta** | LLM-managed hierarchy and runtime paging | LLM tokens per interaction |
| **Mem0** | LLM extraction and consolidation (`ADD`/`UPDATE`/`DELETE`) | LLM call per extraction |
| **Zep / Graphiti** | LLM entity and edge extraction at ingest | LLM call per ingest |
| **LangMem** | Developer-defined LLM extraction (hot-path or background) | LLM call per extraction pass |
| **A-MEM** | Unfiltered storage; LLM generates attributes, links, and evolution | ~1.2k tokens per note (reported) |
| **Agent Memory Gate** | Deterministic repetition gate decides review eligibility; satisfaction transitions feed history | Procedures lane: 0 tokens until a key repeats, then one review call per candidate. History lane: one batched classifier call per session with user turns, plus one review call per detected transition. All bounded by the budget ledger. |

**Closest prior work.** [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) (ICML 2025) induces reusable workflows from agent trajectories with an LLM; the repetition gate is a deterministic alternative to that induction step. "Admit on second occurrence" is also a classic cache-admission policy (e.g. 2Q, TinyLFU's doorkeeper); this project applies it to agent memory writes rather than claiming it as a new idea.

**Research question.** Can behavioral evidence (repetition, rediscovery, satisfaction transitions) select procedural coding memory as well as LLM-judged salience, with fewer and more reliable memories, and where does it fail?

Write-path token savings are real but small relative to session cost (A-MEM spent ~13k tokens indexing 12 sessions; a single coding session in these experiments used 80k–370k tokens). The more interesting claims, still untested, concern **precision and staleness**: whether a strict admission gate keeps briefings smaller and less likely to mislead the agent over long horizons.

---

## System Architecture

```text
sessions ──▶ capture (deterministic: rollout readers, usage ledger, cross-session ledger)
                 │
                 ├── PROCEDURES LANE
                 │     repetition gate: same key ≥2× in a session, or in ≥2 sessions of a project
                 │       ├── not repeated ──▶ never reaches a model (0 tokens)
                 │       └── repeated ──▶ redaction gate ──▶ paid review (budget-gated) ──▶ BRIEFING.md
                 │
                 └── HISTORY LANE
                       1 batched classifier call per session (paid, budget-gated)
                         ──▶ deterministic transition detection (milestone / recovery / regression / unresolved)
                         ──▶ paid review per transition (since 2026-10-14) ──▶ HISTORY.md
                                                                    │
                                                                    ▼
                                              .project-memory/ BRIEFING.md + HISTORY.md
                                                                    │
                                                                    ▼
                                              next session reads at startup (AGENTS.md)
```

### Design Invariants

1. **Repetition-Gated Review (procedures lane):** A procedural candidate becomes eligible for paid review only when a normalized key repeats $\ge 2$ times within one session (`src/usage-ledger.ts`) or appears in $\ge 2$ distinct sessions of the same project (`src/cross-session-ledger.ts`). Bare conversational flow tokens ("ok", "continue", …) never count. Keys seen once never reach a model.
2. **Fail-Closed Budget Ledger:** Every paid call (reviewer and classifier) atomically reserves quota from a SQLite-backed budget ledger before execution, with hold states for ambiguous network or API failures. The eight-run pilot series ran within a ~$10 inference budget.
3. **Mandatory Provenance & Non-Destructive Supersession:** Every record retains pointers to its source session rollout. Updates use temporal invalidation rather than deletion, preserving an audit trail without a graph database.
4. **Pre-Inference Redaction Gate:** Candidate strings matching credential patterns or high-entropy secret assignments are filtered deterministically before any external LLM call.
5. **Static Briefing Delivery:** Memory is materialized as two plain-text Markdown files (`BRIEFING.md` and `HISTORY.md`) rather than a vector store or chat buffer.

For implementation specifics, see [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md), [`docs/architecture.html`](docs/architecture.html), and [`docs/lit-positioning.md`](docs/lit-positioning.md).

---

## Empirical Evaluation

All experiments below are **pilots** on the author's own repositories, with one briefing snapshot per series and small n. Treat them as evidence that the loop works end to end, not as performance claims.

### Experiment 08: Exploratory comparison vs. A-MEM

**This was not a controlled comparison**, and an earlier version of this README described it as one. The two arms did different things:

- **A-MEM** ingested 12 session-summary notes fresh (8 multi-pass, 4 one-pass) and was scored on its top-3 search results per probe.
- **Agent Memory Gate** did *not* ingest those notes. Its arm was the system's **pre-existing live memory** (`BRIEFING.md` + `HISTORY.md` for 4 projects, ~6k tokens combined), built from earlier sessions, scored by regex over the whole rendered text.

Both arms used `GLM-5.3` for model-dependent steps and the same case-insensitive regex probes.

| Metric | A-MEM (repo as shipped) | Agent Memory Gate |
| :--- | :--- | :--- |
| **LLM calls to ingest these 12 notes** | 11 | 0, because these notes were never ingested |
| **Tokens to ingest these 12 notes** | 13,147 (9,869 prompt + 3,278 completion; 1,095.6/note) | 0 for this corpus; the live memory being probed had been built earlier as part of ~$7.32 of capture and review spend (Oct 1–12, all projects) |
| **Probe recall** | 7 / 7 (all at top-1) | 5 / 7 |
| **What was searched** | top-3 retrieved notes per probe | full text of 4 projects' briefings (~6k tokens) |

**What this shows:** A-MEM's retrieval was excellent on this corpus. The two Agent Memory Gate misses (`run07-result`, `corpus-b-2`) were content that existed only in the notes written for this experiment and had never passed through its capture pipeline, so they measure pipeline coverage, not the gate's recall boundary. (An earlier README wrongly called them "single-session findings that never repeated".) Conversely, one one-pass probe (`corpus-b-1`) was a hit for Agent Memory Gate, so that content reached its memory by some route other than repetition of these notes. "5/5 on the captured subset" was a post-hoc denominator and is no longer claimed.

**Pre-registered criteria:** the cost criterion was not triggered, but only because the gate arm paid nothing to ingest a corpus it did not ingest. The corpus-B criterion (reject if A-MEM answers >50% of probes the gate cannot) landed at exactly 50% (1 of 2 probes). Neither outcome is strong evidence either way.

**What a fair rerun needs:** both systems ingesting the same raw rollouts from an empty state, all paid calls counted on both sides (including the classifier), and the same retrieval budget for scoring. Full protocol and raw outputs: [`experiments/run-08-a-mem-baseline.md`](experiments/run-08-a-mem-baseline.md), [`experiments/run-08-data/`](experiments/run-08-data/).

### Experiments 01–07: Paired agent sessions

Fresh Codex sessions with and without the memory files, on the same commit, with identical task prompts. Documented in [`experiments/first-memory-eval.md`](experiments/first-memory-eval.md).

| Question | What the published data shows |
| :--- | :--- |
| **Does the briefing reduce uncached input tokens?** | Possibly, but not shown. Across the **7 executed pairs**: run 01 +1.8%; run 02 (3 pairs, same task) −7.5%, −28.3%, −20.0%; run 04 (3 pairs) −29.3%, −21.2%, **+14.6%**. Memory used fewer uncached tokens in 5 of 7 pairs (median −20%, mean −12.8%, SD 16.5 points); a two-sided sign test gives p ≈ 0.45. Only two distinct tasks contribute 6 of the 7 pairs, and prompt caching was not controlled. Per-session figures: [`experiments/runs-01-06-summary.json`](experiments/runs-01-06-summary.json). |
| **Does it change procedural compliance?** | Weak signal. In run 02's 3 pairs, memory used `npm --offline --ignore-scripts` in 2/3 runs vs 0/3 for baseline (previously reported as 3/3). One baseline run read a file outside its workspace; no memory run did. |
| **Does it improve task correctness?** | No measurable effect. Both conditions reached the correct result in every pair. |
| **Does stale memory mislead the agent?** | Not in this test. In run 04, the 3 memory-condition runs (whose briefing contained dead paths and stale habits) executed none of the stale commands. |
| **Does the full loop work end to end?** | Yes, mechanically (run 07). Phase 2 used 29% fewer uncached input tokens than phase 1, **but** the phases were different tasks (n = 1 each), so the difference cannot be attributed to memory alone. Phase 2's `BRIEFING.md` contained **zero procedures**: any benefit came from `HISTORY.md` (the satisfaction-transition lane), not from the repetition gate. |
| **Runs 05–06** | Null results, and in run 06 the memory condition cost more. Run 05 (heredoc trap): all three conditions wrote files with Codex's patch tool, so the trap could never fire; all passed first try. Run 06: memory used 2.4× the baseline's uncached input (25.4k vs 10.8k) because it also ran the full test suite. The hand-written `NOTE.md` was not read in run 05 but was read in run 06. See the experiment log. |

---

## Structural Trade-Offs & Limitations

1. **Single-Pass Starvation:** The procedures lane promotes nothing from work done cleanly once. In run 07 phase 1, a full feature build produced zero repetition candidates. The history lane (satisfaction transitions) is the current attempt to cover this gap; it costs one classifier call per session plus one review call per transition, so it is not free.
2. **Sample Size and Design:** 7 executed baseline/memory pairs (runs 01, 02 ×3, 04 ×3) plus one two-phase loop test (run 07), all on the author's repositories with one briefing snapshot per series. No variance analysis, no independent tasks, no ablation separating the two lanes. These results establish that the mechanism runs, not that it helps.
3. **Cross-Project Scaling:** Memory is scoped to per-project Markdown briefings without vector embeddings; scaling behavior across large multi-repo workspaces is unmeasured.
4. **Rollout Format Support:** Ingestion parsers currently support Codex and Hermes session logs only.
5. **Evaluation Granularity:** Probe recall relies on deterministic string/regex matching rather than semantic LLM-as-a-judge grading.

---

## Usage & Reproduction

Requires [Bun](https://bun.sh/) (for native SQLite and TypeScript execution), Python 3 with `pytest` (for the evidence consistency checks), and the `gbrain` package. `gbrain` stores records in an embedded PGLite database inside the process, so no database server or background daemon is needed.

### 1. Prerequisites

Install `gbrain` (record store; runs on embedded PGLite):
```bash
bun install -g github:garrytan/gbrain#43597b1
```
This is gbrain 0.48.5.0, the version installed on 2026-09-09 and used for every run in this repository. `latest-stable` is a moving tag on a frequently released package; newer versions are untested. Set `GBRAIN_PACKAGE_DIR` to use a checkout elsewhere.

### 2. Run the Unit & Invariant Suite

```bash
bun scripts/test.ts          # 133 tests across 28 files; 117 run without gbrain,
                             # the 16 in records, record-boundary, candidate-writer,
                             # project-registry and schema need it installed
```

### 3. Check Evidence Consistency

`tests-run08/` checks that the figures quoted in this README and the experiment write-ups match the raw result JSON files (Run 08) and the per-session summary (Runs 01–06), and that the JSON totals are internally consistent. These are **consistency checks, not independent verification**: the JSON files were produced by the same author's scripts, and the private session logs they were derived from are not published.
```bash
python -m pytest tests-run08/  # 18 consistency checks (14 for Run 08, 4 for Runs 01–06)
```

### 4. Pipeline Entry Points

Each is a standalone script (no background services, plain files + SQLite):

```bash
# Parse session rollouts into the SQLite usage ledger and candidate queue
bun scripts/session-capture.ts

# Run budget-gated LLM review on candidates meeting the repetition threshold
bun scripts/queue-review.ts

# Render .project-memory/BRIEFING.md and HISTORY.md for the target workspace
bun scripts/session-start.ts <target-directory>
```

---

## Repository Structure

| Directory / File | Contents |
| :--- | :--- |
| `src/` | Pipeline (22 modules: rollout parsers, usage and cross-session ledgers, redaction filter, budget ledger, reviewer client, satisfaction classifier, Markdown renderers). Capture and gating are deterministic; the reviewer and classifier make paid LLM calls. |
| `test/` | 133 unit and invariant tests executed via `scripts/test.ts` |
| `tests-run08/` | 18 pytest consistency checks: quoted figures match the Run 08 JSON and the Runs 01–06 summary |
| `schema/` | Data contracts (7 record types, mutability constraints, confidence ceilings) |
| `experiments/` | Protocols and results for Runs 01–08; raw JSON for Run 08 and per-session figures for Runs 01–06 (rollouts themselves are private) |
| `evidence/` | Verification logs from canonical test suite executions |
| `docs/` | Architecture diagrams, formal design notes, and literature review |

---

## Provenance & License

Released under the MIT License. This repository is a sanitized export of an internal research codebase (reference commit recorded in `SOURCE_COMMIT.txt`), with local filesystem paths normalized and private session logs omitted. Run 08 figures are consistency-checked against its raw JSON (`python -m pytest tests-run08/`). Runs 01–06 figures are checked against `experiments/runs-01-06-summary.json`, extracted from private rollouts that are not published; Run 07 figures come from the experiment log.

## Next Steps

The open questions, in the order they will be tested:

1. **Ablation.** Which lane produces the benefit? Arms: no memory, a hand-written note wired the same way as the memory files, an LLM summary of the last session, procedures lane only, history lane only, both lanes, and an existing memory framework. Run on a public benchmark (e.g. SWE-ContextBench) with automated, headless agent runs and enough tasks per arm to report variance.
2. **Fair rerun of Run 08.** Both systems ingest the same raw rollouts from an empty state, all paid calls counted.
3. **Staleness over time.** Procedural memories are executable claims ("the test command is X"), so they can be checked at session start without an LLM. The plan is a benchmark built by replaying a real repository's history through periods where conventions change, measuring how often agents follow stale memory with and without verification.

## Corrections (2026-10-18)

The original release overstated several results. This revision:

- **Run 08:** no longer called a controlled comparison. The gate arm probed pre-existing memory rather than ingesting the corpus, so its "0 write tokens" did not measure ingestion cost. The explanation of the two misses now matches the experiment log (coverage, not the gate's recall boundary), and the post-hoc "5/5 on captured subset" figure is withdrawn.
- **Write-path cost:** the claim of "0 tokens" / "eliminates LLM-judged salience" is replaced with a full account. The history lane makes one paid classifier call per session plus one review call per transition.
- **Run 07:** the 29% figure compared two different tasks, and the briefing held zero procedures; any benefit came from the history lane, not the repetition gate.
- **Runs 01–04:** "9 pairs" corrected to **7**. Run 03's three planned reps were never executed (their workspaces have no sessions); run 02 was instead run three times, and the earlier count appears to have treated those re-runs as run 03. "10–29% reduction" replaced with per-pair figures (+14.6% to −29.3%; memory better in 5 of 7).
- **Run 04:** the original log misrecorded rep 3's baseline as 40.2k uncached tokens; the session record shows 35.1k, so rep 3 is +14.6% for memory, not +1%. "6/6 trials" corrected to the 3 runs that actually had memory.
- **Compliance:** `--offline --ignore-scripts` adherence corrected from 3/3 to 2/3.
- **Evidence tests:** described as consistency checks rather than verification.
- **Setup:** `gbrain` uses embedded PGLite (no server); the version used for all runs is now pinned (0.48.5.0, commit `43597b1`).
