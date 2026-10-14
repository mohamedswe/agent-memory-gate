# Session usage ledger (short-term memory increment)

## Purpose

Inside a live session, cheaply measure which pieces of information are actually load-bearing, and gate the paid reviewer so only rehearsed/re-derived knowledge is promoted to long-term memory. Inspired by Mohamed's proposal: repetition of use within a session is evidence of importance.

## Position in the pipeline

`session events -> normalizer -> [usage ledger] -> promotion candidates -> (later) redaction -> reviewer -> record contract -> owning brain`

The ledger is the session's short-term store. It is in-memory, per-session, and never persisted itself — only its conclusions (candidates with counts) flow forward.

## Signal types (deterministic, free)

- **user_repeats**: the user (or caller) re-states the same information. Strongest signal — it means the system failed to retain/use it. Counted per normalized info key.
- **agent_rediscovery**: the agent performs the same effective tool call/discovery again because the earlier result wasn't kept. Counted per (tool, normalized args) key.
- **raw_mentions**: text frequency of an info key. Recorded but NOT a promotion signal on its own — high frequency with no repeats/rediscovery is scaffolding (file paths, boilerplate), not knowledge.

## Identity and normalization

- Info keys: case-folded, whitespace-collapsed text. Exact-match for v1; semantic dedupe is a later, paid concern.
- First version uses deterministic normalization only. No embeddings.

## Promotion rule (v1)

A key becomes a candidate when `user_repeats >= 2` OR `agent_rediscoveries >= 2`. Raw mentions alone never promote. The candidate record carries all three counts as provenance for the reviewer.

## What this increment is NOT

- It does not decide truth or importance — only observed usage.
- It does not call any model, touch any live session file, or write to any brain.
- Real Codex/Hermes sessions are acceptance/validation material (redacted), never unit-test fixtures: tests must have known expected counts, and evidence logs are committed to the repo.

## Test plan (vertical slices, one behavior each)

1. User-repeated information is counted and becomes a candidate with counts.
2. Agent-rediscovered tool calls are counted and become a candidate.
3. Raw-mention-only keys are counted but never promoted.
4. Normalization: case/whitespace variants of the same statement hit the same key.
5. Distinct keys stay distinct; counts don't bleed.
6. Later: feed real redacted session(s) through the ledger as an acceptance check (counts sanity, not committed as tests).
