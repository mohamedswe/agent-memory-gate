# Dual-brain: literature positioning (2026-10-12)

The question this doc answers: *what exists in the agent-memory space, and what
exactly does this system claim that nothing else does?* It is the seed of the
public technical report and the research statement.

## The landscape in one table

| System | Core mechanism | Salience/selection (what gets remembered) | Cost model | Evaluation |
|---|---|---|---|---|
| **MemGPT / Letta** (Packer et al., arXiv 2310.08560) | OS-inspired memory hierarchy; the LLM itself pages information between context and archival storage (self-editing memory blocks) | LLM-decided at runtime (the agent calls memory tools) | LLM tokens spent on memory management as part of every interaction | Letta's own recent benchmark: "is a filesystem all you need?" — notably Letta did NOT publish LongMemEval numbers |
| **Mem0** (arXiv 2504.19413; $24M Series A) | Extract → consolidate → retrieve pipeline; two-stage: extraction (cheap LLM pull of durable facts) + consolidation (LLM decides ADD/UPDATE/DELETE/NOOP against existing store); graph variant Mem0ᵍ | LLM-judged importance at write time + similarity-based merge/dedupe (0.85 merge / 0.9 dedupe thresholds); April 2026 "Dream" adds background consolidation with strict merge/supersede rules, lifecycle states, conditional writes | Self-reported vs OpenAI Memory: 26% LLM-judge gain, 91% latency reduction, 90% token savings (LOCOMO/ECAI) | LOCOMO, LongMemEval; widely criticized for evaluating with LLM-as-judge on benchmarks close to their own design |
| **Zep / Graphiti** (arXiv 2501.13956) | Temporal knowledge graph: episodic / semantic / community subgraphs; conflicts resolved via temporal metadata (invalidate, don't discard) | LLM extraction of entities/edges at ingest; temporal validity intervals | LLM calls per ingest; graph ops | LongMemEval, DMR (their custom benchmark); found ~18% error reduction on LoCoMo vs. full-context |
| **LangMem** (LangChain SDK) | Primitives: hot-path memory tools + background memory manager; flat JSON in namespaced store; unique feature: prompt optimization as a memory type | Developer-defined memory types; agent- or background-extraction | LLM tokens per extraction pass | None published by LangChain themselves |
| **A-MEM** (Xu et al., NeurIPS 2025, arXiv 2502.12110) | Zettelkasten: atomic notes with LLM-generated contextual attributes; embedding-based link generation; memory evolution (new notes update old notes' representations) | LLM-generated attributes + similarity linking; no importance gate at all — everything becomes a note | ~1,200 tokens per memory op claimed (85–93% reduction vs baselines) | LoCoMo (F1), DialSim; strong multi-hop gains; retrieval time flat to 1M entries |

Benchmarks in active use: **LoCoMo** (long conversations, F1 + LLM-judge), **LongMemEval / V2** (5 abilities: extraction, multi-session, temporal, knowledge updates, abstention; 30% accuracy drop for commercial assistants; V2 scales to web agents), plus newer agent-task benchmarks (MemoryArena, BEAM, AgentLongBench) moving from chat QA toward agentic tasks.

## Where dual-brain sits — the honest claim

Every system above decides *what deserves to be a memory* with an LLM call at
write time (or stores everything and filters at read time). Dual-brain's core
move is different: **salience is determined deterministically by observed
repetition + budget, with paid LLM inference gated behind a deterministic
budget ledger.** Specifically:

1. **Repetition-as-importance.** A procedure is promoted only when the usage
   ledger observes the same non-trivial work repeated ≥2 times across sessions
   (with flow-token exclusion). No LLM judges importance; the agent's own
   behavior does. Cognitive grounding: rehearsal/consolidation — what is
   repeated is what is consolidated.
2. **Satisfaction-transition markers.** User affect (frustration→resolution
   arcs) as a capture signal for what mattered. Nobody in the table uses the
   user's satisfaction as a memory-selection signal; MemGPT/Zep/A-MEM are all
   content-driven.
3. **Cost as a first-class invariant.** Budget ledger with atomic reservation
   and ambiguous-failure holds around every paid call. The eval series itself
   tracks dollars per run (~$10 ceiling). Published systems report token
   savings; none treat the paid-inference gate itself as a designed,
   tested component.
4. **Provenance-mandatory records.** Every fact carries provenance
   (session, turn); supersession never deletes (like Zep's temporal
   invalidation, but simpler — no graph required).

## The falsifiable question (thesis-sized)

*Does deterministic repetition-gating capture the same durable knowledge as
LLM-judged salience (Mem0-style extraction/consolidation) at 1–2 orders of
magnitude lower write-time cost — and where does it fail?*

The known failure is already in hand: **the repetition gate starves on
one-pass work** (run-07 — competent single-pass sessions produce zero
procedures; savings came entirely from HISTORY/milestone context). This is the
structural finding that makes the research question real: the gate needs a
second signal (satisfaction markers as promotion evidence, or session-level
review), and testing whether it can match LLM-judged salience without becoming
LLM-judged salience IS the experiment.

## What the eval series already says (and what it doesn't)

| Claim | Verdict (runs 01–07) | Note |
|---|---|---|
| Briefing saves input tokens | YES — 10–29% consistent | 9 pairs + run-07 phases |
| Briefing improves discipline | YES, small but clean | canonical-runner wiring, no false greens |
| Briefing changes correctness on repo-derivable tasks | NO | smart agents re-derive; this is a finding, not a failure |
| Stale content gets followed | NO — survived baiting | run-04 trap |
| Loop works end-to-end on real work | YES | run-07: −29% uncached, correctness tie |

Not yet done: a **direct comparison arm vs Mem0** (or A-MEM) on the same
workload — the missing piece for any external claim. A-MEM is the cleaner
baseline than Mem0: open source, self-hosted, no API-key entanglement, and its
"no importance gate, store-and-link everything" stance is the exact opposite
pole to repetition-gating.

## Positioning one-liners (for the research statement / README)

- "Everyone else asks an LLM what's worth remembering. We watch what the agent
  actually does twice."
- "Memory selection without a salience model: repetition and budget as the
  only gates."
- "An honest null result: on derivable tasks, memory buys efficiency (−29%
  uncached input) and discipline, not correctness — and the repetition gate
  starves exactly where you'd want procedures most: one-pass competent work."

## Threats to the position (be ready for these)

1. **"Repetition is just a heuristic; LLM salience will beat it on recall."**
   Probably true on chat benchmarks (LoCoMo-style) — which is why the claim is
   scoped to *procedural/agentic* memory for coding agents, where repetition is
   meaningful signal (commands re-run, errors re-hit), not to user-fact recall.
2. **"Mem0's April 2026 single-pass ADD-only algorithm moved their direction."**
   Their new algorithm reduces LLM judgment at write time — the field is
   converging toward cheap write paths. Good: it validates the cost thesis.
   Our distinction is that the gate is *observable behavior*, not extraction.
3. **"Small-n evals."** 9 pairs + run-07 is honest but small. The Mem0/A-MEM
   comparison arm with more pairs is the answer; also position as
   engineering-methodology research (deterministic pipeline, reproducible)
   rather than a claims-leaderboard paper.
4. **"No embeddings — retrieval is project-scoped files."** True and
   intentional (the deliverable is a briefing file an agent reads unprompted),
   but it caps scale. The comparison experiment should test at what memory
   size per-project briefings stop being viable.

## Sources

- MemGPT: arXiv 2310.08560; letta.com/blog (agent-memory, benchmarking posts)
- Mem0: arXiv 2504.19413; mem0.ai blog (long-term memory, Dream consolidation,
  benchmarks-in-2026 pages); github.com/mem0ai/mem0 (April 2026 ADD-only algo)
- Zep/Graphiti: arXiv 2501.13956; github.com/getzep/graphiti
- LangMem: langchain.com/blog/langmem-sdk-launch; langchain-ai.github.io/langmem
- A-MEM: arXiv 2502.12110, NeurIPS 2025; github.com/agiresearch/A-mem
- LongMemEval: ICLR 2025 (arXiv 2505.xxxx / xiaowu0162/LongMemEval);
  LongMemEval-V2: arXiv 2605.12493
