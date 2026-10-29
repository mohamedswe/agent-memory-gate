# Agent Memory Gate

**Deterministic Memory Selection for Coding Agents via Behavioral Repetition and Budget Ledgers**

`agent-memory-gate` is an experimental memory architecture for autonomous coding agents that eliminates LLM-judged salience at write time. Instead of invoking a language model to extract or score memories during ingestion, candidate procedures are promoted strictly when the agent's observed execution patterns repeat across sessions ($\ge 2$ occurrences). All downstream LLM consolidation sits behind a deterministic, fail-closed SQLite budget ledger. The resulting memory state is rendered as a static per-project briefing (`BRIEFING.md` and `HISTORY.md`) consumed at session initialization.

This repository contains the deterministic ingestion and gating pipeline (123 original unit and invariant tests), evaluation tooling with additional tests, protocols and selected sanitized artifacts through Run 10 (including null and negative results), and an exploratory comparison against A-MEM (NeurIPS 2025).

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
| **Agent Memory Gate** | Deterministic repetition gate ($\ge 2$ sessions) + budget ledger | **0 tokens** on single-pass work; bounded afterward |

**Core Hypothesis:** Can behavior-derived salience (observed command and workflow repetition) approximate LLM-judged salience for procedural coding memory at zero initial write cost, and what are the exact recall boundaries where this heuristic fails?

---

## System Architecture

```text
sessions ──▶ capture (deterministic: rollout readers, usage ledger)
                 │
                 ▼
        repetition gate ──── ≥2 repeats across sessions ───▶ paid review (budget-gated)
                 │                                                 │
                 └─── 1 repeat ──▶ discarded (0 tokens)            ▼
                                                          candidate records
                 satisfaction markers ─────────────────────────────▶ HISTORY
                                                                    │
                                                                    ▼
                                              .project-memory/ BRIEFING.md + HISTORY.md
                                                                    │
                                                                    ▼
                                              next session reads at startup (AGENTS.md)
```

### Design Invariants

1. **Repetition-Gated Promotion:** A procedural candidate is promoted only when the usage ledger records identical normalized command keys across $\ge 2$ distinct sessions (excluding common flow tokens). Single-occurrence actions incur zero token cost.
2. **Fail-Closed Budget Ledger:** Paid LLM review calls must atomically reserve quota from a SQLite-backed budget ledger prior to execution, utilizing hold states for ambiguous network or API failures. The entire eight-run evaluation series executed within a ~$10 inference budget.
3. **Mandatory Provenance & Non-Destructive Supersession:** Every record retains pointers to its source session rollout. State updates use temporal invalidation rather than deletion, preserving an immutable audit trail without requiring a graph database.
4. **Pre-Inference Redaction Gate:** Candidate strings matching credential patterns or high-entropy secret assignments are filtered deterministically before reaching any external LLM review call.
5. **Static Briefing Delivery:** Memory is materialized as two plain-text Markdown files (`BRIEFING.md` and `HISTORY.md`) rather than an active vector store or chat buffer.

For implementation specifics, see [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md), [`docs/architecture.html`](docs/architecture.html), and [`docs/lit-positioning.md`](docs/lit-positioning.md).

---

## Empirical Evaluation

### Experiment 08: Controlled Comparison vs. A-MEM (NeurIPS 2025)

A-MEM freshly ingested 12 session-summary notes; Agent Memory Gate was evaluated against existing memory generated from earlier sessions. Seven probes were scored using deterministic, case-insensitive regex matching. Both arms used `GLM-5.3` for model-dependent steps. These different ingestion histories make this an exploratory comparison rather than an equal-history end-to-end benchmark.

| Metric | A-MEM (Reference Implementation) | Agent Memory Gate |
| :--- | :--- | :--- |
| **Write-path LLM calls** | 11 | 0 (deterministic capture and gating) |
| **Write-path token cost** | 13,147 (9,869 prompt + 3,278 completion; 1,095.6/note) | 0 |
| **Probe recall** | 7 / 7 (100% at top-1) | 5 / 7 (100% on captured subset) |
| **Ingestion wall time** | ~30s | <1s |

**Analysis:** A-MEM achieved 7/7 recall on fresh ingestion at a cost of 13,147 write tokens. Agent Memory Gate achieved 5/7 recall with zero incremental review calls in the measured ingestion window; its existing memories had incurred earlier review costs. The misses demonstrate a coverage gap, but different ingestion histories prevent attributing that gap solely to the repetition rule. Full protocol: [`experiments/run-08-a-mem-baseline.md`](experiments/run-08-a-mem-baseline.md); selected result artifacts: [`experiments/run-08-data/`](experiments/run-08-data/).

*Implementation Note on A-MEM:* Inspection of the public A-MEM repository revealed that `analyze_content` (the attribute-generation LLM call described in the paper) is unreachable dead code in the current `HEAD`. Consequently, our measured token cost for A-MEM represents a lower bound relative to the published specification.

### Experiments 01–07: End-to-End Task Evaluation

We conducted nine paired fresh-agent sessions alongside a full-loop realistic workflow test, comparing memory-primed agents against bare baseline agents on repository-level coding tasks:

| Evaluated Hypothesis | Outcome | Empirical Evidence |
| :--- | :--- | :--- |
| **Reduces session input tokens** | **Observed in early runs; not established generally** | Runs 01–04 reported reductions across 9 pairs; Run 07 used different tasks. The later Run 10 follow-up did not show a token-efficiency gain. |
| **Improves procedural compliance** | **Supported** | `--offline` / `--ignore-scripts` adherence: 3/3 vs. 0/3; zero false-positive test runs |
| **Improves task correctness on repo-derivable tasks** | **Null** | Final patches converged across all pairs; baseline agents re-derive context via extra exploration |
| **Following the tested stale advice** | **Not observed** | Zero stale commands in the 3 memory-condition sessions of run 04; the other 3 sessions were baselines. This does not establish general injection resistance. |
| **End-to-end viability on multi-step workflows** | **Demonstrated on one workflow** | Run 07 exercised capture through consumption. Its 29% input difference compares different tasks and does not isolate a causal memory effect. |

Full experimental protocols and session traces are documented in [`experiments/first-memory-eval.md`](experiments/first-memory-eval.md).

---

## Structural Trade-Offs & Limitations

1. **Single-Pass Starvation:** Because the repetition gate requires $\ge 2$ observations across sessions, tasks solved cleanly in a single session generate no recurring signals and are not promoted. In Run 08, the 4 single-pass notes required 5,611 tokens for A-MEM to index, whereas the repetition gate discarded them by design. Closing this recall gap without reintroducing per-write LLM calls (e.g., using user satisfaction-transition markers as a secondary promotion trigger) remains future work.
2. **Sample Size:** Early evaluation includes 9 paired agent runs and a 12-note comparative corpus. Runs 09 and 10 each add three tasks across three conditions, with one attempt per task-condition. These selected samples do not establish everyday productivity or broad statistical generalization.
3. **Cross-Project Scaling:** Memory is scoped to per-project Markdown briefings without vector embeddings; scaling behavior across large multi-repo workspaces is unmeasured.
4. **Rollout Format Support:** Ingestion parsers currently support Codex and Hermes session logs only.
5. **Evaluation Granularity:** Probe recall relies on deterministic string/regex matching rather than semantic LLM-as-a-judge grading.

---

## Usage & Reproduction

Requires [Bun](https://bun.sh/) (for native SQLite and TypeScript execution) and Python 3 (for evidence verification). No external database servers or background daemons are required.

### 1. Prerequisites

Install `gbrain` (Postgres-native memory engine):
```bash
bun install -g github:garrytan/gbrain#latest-stable
```

### 2. Run the Unit & Invariant Suite

```bash
bun scripts/test.ts          # Core and evaluation-tooling tests (160 tests)
```

### 3. Verify Experimental Evidence

The evidence suite checks selected Run 08 figures and documentation against stored JSON results. It does not rerun ingestion or retrieval, independently rescore recall, or validate causal productivity claims:
```bash
python -m pytest tests-run08/  # Executes the 14 automated evidence verification tests
```

### Current value-validation pilot

The new [Run 09 methodology baseline](experiments/run-09-methodology-baseline.md)
uses three real defects, identical source snapshots, and baseline / static-note /
automatic-memory conditions. All nine OpenAI/Codex runs passed automated
acceptance and regression checks. Onboarding produced zero learned memories,
so the pilot did not establish an automatic-memory benefit. The report retains
overhead and methodology limitations; it does not establish everyday productivity.

The subsequent [capture identity fix](docs/CAPTURE-IDENTITY.md) replays those
same sessions through the production capture CLI and now queues five repeated
action candidates, including the source-supported test command. This is a
capture correction, not a replacement for the original experiment results.

The completed [Run 10 Codex follow-up](experiments/run-10-capture-fixed.md)
retained one test-command memory after reviewing five candidates. All nine fresh
patches passed automated checks. Memory used 18.9% more uncached-input-plus-output
tokens for execution than baseline, and 118.3% more including formation. This
small sample demonstrates working capture and delivery, with no added development
value established. It does not support a general token-savings claim.

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
| `src/` | Core deterministic pipeline (22 modules: rollout parsers, usage ledger, redaction filter, budget ledger, reviewer client, satisfaction classifier, Markdown renderers) |
| `test/` | 160 core and evaluation-tooling tests executed via `scripts/test.ts` |
| `tests-run08/` | Automated evidence verification suite (14 pytest tests checking all reported figures against raw JSON outputs) |
| `schema/` | Data contracts (7 record types, mutability constraints, confidence ceilings) |
| `experiments/` | Protocols, analysis, and selected artifacts through Run 10 |
| `evidence/` | Verification logs from canonical test suite executions |
| `docs/` | Architecture diagrams, formal design notes, and literature review |

---

## Provenance & License

Released under the MIT License. This repository is a sanitized export of an internal research codebase (reference commit recorded in `SOURCE_COMMIT.txt`), with local filesystem paths normalized and private session logs omitted. Automated evidence tests (`python -m pytest tests-run08/`) verify selected Run 08 arithmetic and documentation consistency against stored result artifacts; they do not independently establish causal performance claims.

## Citation-Worthy Framing

If you build on this, the comparison to replicate is: *deterministic repetition-gating vs LLM-judged salience on identical procedural corpora, measuring write-path cost and ground-truth probe recall.* The open question worth pursuing: *can a second behavioral signal (user satisfaction transitions) close the one-pass starvation gap without reintroducing per-write LLM cost?*
