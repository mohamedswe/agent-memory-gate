# Run 08 protocol: dual-brain vs A-MEM — write-path cost and memory quality (2026-10-12)

## The falsifiable question (from docs/lit-positioning.md)

*Does deterministic repetition-gating capture the same durable knowledge as
LLM-judged salience (A-MEM's store-everything + LLM-organize approach) at
1–2 orders of magnitude lower write-time cost — and where does it fail?*

## Why A-MEM as the baseline (not Mem0)

- Open source, self-hosted, no API entanglement beyond the LLM itself.
- It is the **exact opposite pole**: A-MEM stores everything as notes and uses
  an LLM at write time to generate attributes/links/evolution. Dual-brain
  promotes nothing without observed repetition and spends $0 on non-repeated
  work. If there's a difference in cost, it shows here at maximum contrast.
- NeurIPS 2025 paper gives it credibility as "the" academic agentic-memory
  baseline.

## The corpus (the input both systems ingest)

The **same raw material** both systems would see in production: the actual
session transcripts already captured by dual-brain's pipeline. Concretely:

- **Corpus A (multi-pass work):** phase-1 run-07 transcript (the redaction-
  report build session — 43.5k uncached input, real rediscoveries, the
  canonical-runner rule, heredoc failure) + the 2 heredoc-corruption sessions
  from 2026-10-11 + the queue-stats phase-2 transcript.
- **Corpus B (one-pass work):** the session-capture output for recent
  competent one-pass sessions (where we KNOW the repetition gate promotes
  nothing — the starvation case).

Both systems ingest identical inputs as document-per-session (or
document-per-meaningful-exchange, applied identically).

## Conditions

| Condition | System | Write path | Cost measurement |
|---|---|---|---|
| 1 | **A-MEM** | add_note() per session/exchange; LLM = z-ai/glm-5.3 via nous gateway (same model dual-brain's reviewer uses — fairness on quality axis) | tokens + wall time per add_note; total for corpus |
| 2 | **dual-brain** | existing pipeline: session-capture → ledger → repetition gate → (only repeated candidates) queue-review paid call → record | tokens + wall time; count of paid calls made |

**The key fairness point:** dual-brain's paid stage is the queue-review LLM
call that only fires on repetition-gated candidates. A-MEM has no gate — every
note pays the LLM tax. The comparison is *total write-path cost for the same
corpus*, not per-note cost.

## Metrics

1. **Write-path cost**: total tokens & wall time & $ (glm-5.3 pricing) per
   corpus, per system.
2. **Memory quality** — this is the hard one; measure on three axes:
   a. **Precision probe:** ask both systems a set of questions a coding agent
      would actually face when resuming work ("what is the canonical test
      command?", "what failed on 2026-10-11 with heredocs?", "what was the
      phase-2 task?"). Score answers against ground truth (the repo/docs).
      Dual-brain renders BRIEFING+HISTORY; A-MEM renders search results.
   b. **Noise:** count junk/duplicate/irrelevant memories surfaced per query
      (A-MEM's known weakness — it stores everything).
   c. **Starvation:** on corpus B, what does each system hold that the other
      doesn't? Dual-brain: expected near-zero procedures (the known failure).
      A-MEM: expected lots of notes — but how many are *useful*?
3. **Read-path cost**: tokens to answer each precision probe (briefing is
   read-once; A-MEM search returns top-k every query).

## Honest confounds, stated up front

1. **The briefing is read unprompted; A-MEM results must be queried.** Different
   consumption models — that's real and part of the claim (dual-brain's design
   is "the agent reads a file at session start", A-MEM's is "the agent searches
   when it needs to"). We measure both consumption costs, not pretend they're
   the same.
2. **glm-5.3 vs the paper's gpt-4o-mini.** We use the same model for both
   quality-relevant stages across systems. Absolute numbers will differ from
   the paper; the *relative* comparison is what's valid.
3. **Corpus is small and ours.** This is one honest point on the curve, not a
   leaderboard claim. The public write-up scopes it as such.
4. **No embeddings in dual-brain** — retrieval is project-scoped files. At this
   corpus size that's fine; the scaling question is noted as future work.

## Budget

- Corpus A: ~5 sessions → A-MEM add_note × ~5-15 exchanges each ≈ 50-90 LLM
  calls; glm-5.3 is cheap; est. $1-2 total. Dual-brain side: capture is free
  (deterministic); paid calls only on gated candidates (~2-4 expected).
- Precision probes: dual-brain free (render + read); A-MEM search is embedding-
  based (local, free) + probe answers read from results (no LLM needed — we
  score the retrieved notes directly against ground truth).
- **Ceiling: $3.** If projected spend exceeds it, stop and re-scope.

## Deliverables

1. `experiments/run-08-a-mem-baseline.md` — protocol + results in the repo
   (this doc becomes its header).
2. Data: per-call token logs from A-MEM (litellm gives usage per call);
   dual-brain's budget ledger already logs.
3. A public technical write-up of the comparison — the external artifact
   this experiment feeds.

## Sequence

1. Set up A-MEM venv (uv), point it at nous gateway via OPENAI_BASE_URL +
   OPENAI_API_KEY + model=z-ai/glm-5.3. Smoke test: one add_note + search.
2. Assemble corpus A + B exports (session-capture already produces these).
3. Ingest corpus into A-MEM; log per-call cost. Run dual-brain's pipeline on
   the same corpus (already partially done — run-07 capture exists).
4. Precision probes on both; score against ground truth.
5. Write up, honestly, including where A-MEM beats us.
6. Author review before anything public.
7. Then: sanitized public repo + technical report + public write-up.

## What would make us reject the repetition-gate hypothesis (pre-registered)

- A-MEM's precision-probe recall ≥ dual-brain's briefing recall on corpus A,
  AND A-MEM write cost ≤ 3× dual-brain's (i.e., LLM-judged salience is cheap
  enough that the deterministic gate buys nothing).
- On corpus B: A-MEM's notes answer >50% of probes that dual-brain (starved)
  cannot.

---

# Run 08 RESULTS (2026-10-12, re-run on sanitized corpus) — executed, not projected

Setup as planned. A-MEM arm: cloned agiresearch/A-mem @ HEAD, uv venv,
llm_backend=openai pointed at the same nous gateway dual-brain's reviewer uses
(z-ai/glm-5.3, temperature 0.7 — A-MEM's default), local all-MiniLM-L6-v2
embeddings. Corpus: 12 session-summary notes (8 multi-pass corpus-A, 4 one-pass
corpus-B; career-related notes replaced with real Insectflux procedures before
the re-run so the dataset is publishable). Scripts + raw JSON in
Development/Local/a-mem-baseline/. Probe scoring: case-insensitive regex on
returned content, applied identically to both arms.

## Implementation realities discovered (matters for reproducibility)

1. **This A-MEM repo version's `analyze_content` (LLM attribute generation)
   is defined but never called** — `add_note` only invokes the evolution-
   decision LLM call (from note #2 on; note #1 skips all LLM work when the
   store is empty). So our measured per-note cost is the *lower bound* of the
   paper-faithful pipeline (~1,200 tokens/op claimed in the paper includes
   attribute generation; we measured the repo as shipped).
2. One evolution call in the first run returned invalid JSON (glm-5.3 didn't
   produce the schema) — A-MEM's try/except swallowed it silently. Counted
   as cost, evolution lost. (No such failure in the re-run.)
3. First note is free by design (empty store shortcut) — cost figures below
   are steady-state from note #2.

## Write-path cost (the primary axis)

| metric | A-MEM (as shipped) | dual-brain |
|---|---|---|
| LLM calls for 12 notes | **11** (0 on note 1, 1/note after) | **0 paid review calls for this corpus** — capture+ledger are deterministic; the gate had already promoted the software-auditor candidates in earlier sessions (paid then, ~$7.32 total ledger Oct 1–12 across ALL capture work) |
| Write tokens | **9,869 p + 3,278 c = 13,147** (1,095.6/note steady state) | **0** for corpus ingestion itself |
| Wall time | ~30s for 12 notes | <1s (deterministic passes) |

**Per-note steady-state cost (A-MEM, glm-5.3): ~1,096 tokens.** Extrapolated
honestly: 100 sessions/month of one-pass work = ~110k write tokens/month A-MEM
vs 0 for a gate that (by design) promotes nothing from one-pass sessions. On
multi-pass work the gate pays the review call only for repeated candidates.

## Probe recall (the quality axis) — 7 probes, ground-truth-scored, case-insensitive

| probe | A-MEM top-3 (top-1) | dual-brain (rendered briefings, 4 projects) |
|---|---|---|
| canonical-test (scripts/test.ts) | HIT (top-1) | HIT |
| heredoc-failure | HIT (top-1) | HIT |
| graph-determinism (SHA-256) | HIT (top-1) | HIT |
| run07-result (-29%) | HIT (top-1) | MISS (result never captured into memory yet) |
| typecheck | HIT (top-1) | HIT |
| corpus-b-1 (Insectflux docker compose) | HIT (top-1) | HIT |
| corpus-b-2 (post draft) | HIT (top-1) | MISS (content never captured) |
| **recall** | **7/7 (7 top-1)** | **5/7** |

The two dual-brain misses (run07-result, corpus-b-2) are exactly the probes
whose ground truth only exists in notes written for this experiment but never
fed through dual-brain's own capture pipeline — a fairness artifact of
comparing A-MEM's fresh ingestion vs dual-brain's live memory rendered from
earlier sessions. Stated plainly: **on content its pipeline had actually
captured, dual-brain recall is 5/5; A-MEM wins the two probes whose content
only exists because A-MEM ingested the corpus fresh.** Both misses are
pipeline coverage, not retrieval failure. A-MEM's retrieval quality on this
corpus is excellent — 7/7 with every answer at top-1.

## Read-path cost (the consumption axis)

- dual-brain: agent reads its project's BRIEFING+HISTORY at session start —
  590–3,049 tokens depending on project (per-project figures in
  run08_dualbrain_results.json). Read once, unprompted, via AGENTS.md wiring.
- A-MEM: search per query, ~0.02s, top-k notes; consumption cost depends on
  query count — one query ≈ reading 3 notes (~400 tokens), but each new
  question is a new search; the agent must know to ask.

## Verdict — the pre-registered question answered

**Does repetition-gating capture the same durable knowledge as LLM-judged
salience at orders-of-magnitude lower write cost?** On this corpus:

1. **Cost: decisively yes.** 13,147 tokens / 11 paid calls vs 0 paid calls for
   identical ingestion. The gate's write-path advantage is real, not projected.
2. **Quality: A-MEM won this arm — 7/7 vs 5/7.** A-MEM's retrieval on the
   freshly-ingested corpus was perfect (all 7 answers at top-1). dual-brain
   matched it on everything its pipeline had captured (5/5) and missed the
   two probes whose content its pipeline had never ingested. We do NOT claim
   quality parity with A-MEM on fresh ingestion — we claim comparable recall
   *on captured content* at zero write cost, and A-MEM's advantage is exactly
   the coverage the gate structurally lacks.
3. **The trade is exactly as theorized:** A-MEM pays ~1.1k tokens/note
   unconditionally and gets universal coverage; dual-brain pays ~0 on one-pass
   work and structurally cannot hold what never repeats — visible in the
   run07/corpus-b-2 misses.
4. **The starvation problem is now externally evidenced, not just internal:**
   corpus B (one-pass notes) cost A-MEM 5,611 tokens to ingest (4 notes, all 4
   paying the steady-state evolution call — see run08_amem_results.json notes
   op-1..op-4) and gave it working recall on 2/2 corpus-B probes; dual-brain's
   gate holds none of it by design. That's the open research question, measured.

## Honest limitations

- n=1 corpus, 12 notes, 7 probes — one point on the curve, not a leaderboard.
- A-MEM's repo as shipped ≠ paper pipeline (attribute generation not called);
  the paper-faithful cost would be HIGHER than measured, favoring us — flagged
  rather than hidden, and the paper-faithful arm is a follow-up if reviewers
  care.
- glm-5.3 for both systems' quality-relevant calls; absolute numbers differ
  from the paper's gpt-4o-mini setup; relative comparison is the claim.
- Probe scoring used case-insensitive regex ground truth, not LLM-judge —
  coarse but deterministic and reproducible; both arms scored identically.
- The first run (before corpus sanitization) scored A-MEM 6/7 on
  case-sensitive string matching; the re-run with corrected case-insensitive
  scoring scored 7/7. Both runs' raw data retained in git history of the
  private repo; the public dataset is the sanitized re-run.

## Reproduction

- A-MEM arm: `cd Development/Local/a-mem-baseline && PYTHONPATH= VIRTUAL_ENV=
  .venv/Scripts/python.exe scripts/run08_amem.py` (needs
  ~/.hermes/profiles/edge/auth.json nous credentials)
- dual-brain arm: `scripts/run08_dualbrain.py` in the same dir
- Raw (sanitized re-run): run08_amem_results.json, run08_dualbrain_results.json

---

## Correction (2026-10-18)

The verdict above overstates what this run shows. Kept unedited for the record; read it with these corrections:

1. **Not a controlled comparison.** The A-MEM arm ingested the 12 notes. The dual-brain arm did not; it probed the system's pre-existing live memory for 4 projects (~6k tokens), built earlier from other sessions. "0 paid calls" therefore measures a corpus that was never ingested, not the gate's write cost. Point 1 of the verdict ("Cost: decisively yes") is withdrawn.
2. **Scoring differed between arms.** A-MEM was scored on top-3 retrieved notes; dual-brain on regex over the full text of all four projects' briefings.
3. **The misses are coverage, as this document says, not the gate's recall boundary.** The README previously described them as single-session findings that never repeated; that was wrong and has been corrected there. `corpus-b-1` (a one-pass note) was a dual-brain hit, so that content reached memory by another route.
4. **"5/5 on captured content"** is a post-hoc denominator and is no longer claimed.
5. **Pre-registered corpus-B criterion** (reject if A-MEM answers >50% of probes dual-brain cannot) landed at exactly 50% (1 of 2), which is not informative either way.
6. **The dual-brain write path is not LLM-free.** Its history lane makes one paid classifier call per session with user turns and, since 2026-10-14, one review call per detected transition.

A fair rerun requires both systems to ingest the same raw rollouts from an empty state, count all paid calls on both sides, and use the same retrieval budget when scoring.
