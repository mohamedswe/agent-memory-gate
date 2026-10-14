# Candidate-to-memory pipeline — design notes

The reviewed state: 441 promotion candidates across 8 projects, ~80% agent-rediscovery tool calls, 3 user-repeat statements. Per Mohamed's direction: an LLM reviewer can describe and truncate these candidates into memories. This document specifies the deterministic stages that must exist before any paid inference.

## Stage order (deterministic before paid)

```
candidates.jsonl
  -> [1] redaction gate (deterministic, fail-closed)      -- THIS INCREMENT
  -> [2] category filter (wait-calls excluded by default) -- THIS INCREMENT
  -> [3] reviewer (LLM, GLM-5.3 via Nous Portal)           -- BUILT BUT NOT RUN without explicit go
  -> [4] output validation (record contract, provenance)   -- THIS INCREMENT (schema side)
  -> [5] writer: candidate -> MemoryRecord -> owning brain -- THIS INCREMENT (disposable brain only)
```

## [1] Redaction gate — deterministic, fail-closed

A candidate key containing secret-shaped content must never reach the reviewer. Patterns (v1, extensible):

- API keys: `sk-[A-Za-z0-9]{16,}`, `ghp_[A-Za-z0-9]{20,}`, `gho_...`, `xox[bap]-...`, `AKIA[A-Z0-9]{12,}`, `Bearer <token>`
- Assignment shapes: `api_key=`, `token=`, `password=`, `secret=` followed by non-empty value
- Windows credential paths: anything containing `\credentials\` or `:password`

Behavior: a matching candidate is **excluded** from review (not redacted-in-place — we do not trust partial redaction to be complete). Exclusions are counted and listed in the review report, never silently dropped.

## [2] Category filter

`tool:wait:*` candidates are excluded by default (dead category: the agent waiting for a cell result carries no project knowledge). Configurable in the pipeline constructor; the reviewer never sees them unless explicitly enabled.

## [3] Reviewer (built, gated)

Input: one candidate + compact project context (project dir, candidate counts, up to N surrounding session events, already redacted). Output: STRICT JSON — `memory_kind` (one of the seven node kinds), `content` (one-sentence description, <=300 chars), `lifecycle` (proposed/agreed/implemented — default proposed), `evidence` (tentative/verified — default tentative), `justification` (<=200 chars).

The reviewer NEVER promotes anything to `verified` on its own — verification requires evidence pointers from real execution, which this pipeline stage does not have. The reviewer's output is always `proposed`/`tentative` by construction.

## [4] Output validation

Reviewer JSON must pass the record contract validation (`src/records.ts`) before it becomes a `MemoryRecord`. Malformed reviewer output is rejected, not repaired.

## [5] Writer (disposable brain only this increment)

Takes validated reviewer output + candidate provenance (counts, session file, project dir) and creates a `MemoryRecord` via `RecordService.create()` in a disposable PGLite brain. No live brain is written until a separate explicit authorization.

## What this increment is NOT

- No paid call runs. The reviewer client is code-complete and unit-tested with a stubbed HTTP layer; flipping it live needs Mohamed's explicit go + the budget ledger from the design's stage 4.
- No live brain writes.
- No automatic scheduling — the pipeline is run explicitly.
