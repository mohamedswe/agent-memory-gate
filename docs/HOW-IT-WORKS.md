# How everything works — the complete walkthrough

Written 2026-10-08, after the acceptance test passed (a fresh Codex session
answered "how do I run tests" from the briefing). This is the full, honest
picture: what runs, in what order, what enforces what, and what is NOT built.

## The one-paragraph version

Codex records every session as JSONL files. We read them, count what gets
repeated (your statements, the agent's re-discoveries), promote the repeats to
candidates, filter out secrets and noise for free, send each survivor to a
paid LLM that writes one clean project-scoped sentence, validate that
sentence against a strict contract, store it as a record in a G-brain database
linked to a stable project identity, condense near-duplicates into single
canonical records, and render the active ones as a briefing file that a fresh
Codex session reads at startup. Repetition made us look; the reviewer made it
readable; the contract made it honest; the graph made it findable.

## Stage by stage

### 1. The raw material — Codex session logs

Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each line is an
event: `session_meta` (cwd, git branch, timestamps), `response_item`
(user/assistant messages, `function_call`/`custom_tool_call`, their outputs),
plus wrapper events (`event_msg`, `turn_context`) that repeat information.

### 2. The reader — `src/rollout-reader.ts`

Parses those files into typed events: user_message, assistant_message,
tool_call (name + args), tool_output. Three robustness rules, all tested:
duplicates deduplicated by id (wrappers repeat response items), partial
trailing JSONL lines skipped (crash safety), unknown event types ignored.

### 3. The usage ledger — `src/usage-ledger.ts` (the short-term memory)

Mohamed's core idea: information that gets used repeatedly inside a session
is the information that fueled the conversation. Three counters per
normalized key:

- **userRepeats** — you said the same thing again (strongest signal: the
  system failed to retain it)
- **agentRediscoveries** — the agent ran the same effective tool call again
  (it paid the discovery cost twice; the first result should have been kept)
- **rawMentions** — text frequency. Counted but NEVER promotes alone: a path
  appearing 40 times is scaffolding, not knowledge.

Promotion rule: userRepeats >= 2 OR agentRediscoveries >= 2, PLUS a
minimum-content gate ("continue", "ok", empty strings never promote — learned
from real-data probing). Normalization: case-folded, punctuation-stripped for
prose; stable sorted-key JSON for tool args (never "[object Object]").

The ledger is deterministic and free. It is the gate that decides what the
paid reviewer ever sees.

### 4. Export — `scripts/export-candidates.ts`

Walks all rollouts, produces `candidate-review/candidates.jsonl`.
Reality check: 123 sessions -> 441 candidates across 8 projects.

### 5. The redaction gate — `src/redaction-gate.ts`

Deterministic, fail-closed, BEFORE any paid call. Excludes (never
"redacts in place" — we don't trust partial redaction): secret shapes
(sk-..., ghp_..., AKIA..., credential assignments, credential paths) and the
dead wait-call category. Every exclusion is reported with a reason.
Reality check: 441 -> 283 passed, 158 excluded.

### 6. The budget ledger — `src/budget-ledger.ts`

Durable SQLite (`live-run/ledger.db`), monthly cap $10. The design's stage-4
gate, built before any paid call:

- atomic reservation BEFORE each request (cap can never be overshot)
- reconcile with the actual returned `usage.cost` (releases the difference)
- ambiguous failures (timeout) HOLD the reservation — a retry must obtain a
  new one; no free replays
- month rollover resets the allowance, retains history
- refusal = no HTTP call happens at all

### 7. The reviewer — `src/reviewer-client.ts` (the only paid stage)

One candidate per call to GLM-5.3 via the Nous Portal inference API
(OpenAI-compatible). The prompt includes project name, session, signal type,
usage counts, and a scoping instruction ("In <project>: ..."). Contract:

- reserve -> call -> reconcile -> strict validation
- the reviewer can ONLY ever produce lifecycle=proposed, evidence=tentative —
  the validator rejects anything else. It structurally cannot claim verified
  or implemented. Honesty is enforced, not requested.
- bounded output (content <= 300 chars), NOT_WORTH_SAVING escape hatch
- reasoning fallback: GLM's reasoning mode sometimes returns empty content
  with the answer inside `reasoning_content` — we extract the JSON from there
- malformed output is REJECTED, not repaired — but its cost is still
  reconciled (tokens were spent)

### 8. The record contract — `src/records.ts`

Every memory is a typed record stored as a G-brain page (pages/links are
canonical storage — no second database). Enforced fields:

- identity: UUID id, owner (codex|hermes), kind (one of 7 node types),
  projectId (stable slug like `projects/software-auditor`)
- provenance: source session + candidate key, so every memory traces back to
  "you repeated this" or "the agent re-ran this N times"
- THREE INDEPENDENT status axes, never collapsed into one "done" flag:
  - lifecycle: proposed / agreed / implemented
  - evidence: tentative / verified / contested
  - currency: active / superseded / stale
- ownership enforced by the service, not by prompts: cross-owner writes
  denied BEFORE any database mutation; records immutable (conflict on re-create,
  even concurrent); caller input snapshotted before validation (TOCTOU fix)
- visibility private by default; cross-brain read requires world + explicit
  eligibility and returns only a safe projection (no provenance, no paths)
- `verified` requires evidence pointers + verification timestamp — but pointer
  existence never proves truth; that stays a human/later-stage judgment

### 9. The project registry + graph — `src/project-registry.ts`, `src/candidate-writer.ts`

Stable project identity: deterministic slug from the checkout directory name,
so multiple checkouts of one project map to one identity (the alias case the
design required). A Project page is created in the brain; every record gets a
real `belongs_to` typed edge to it via the engine's native links. The schema
vocabulary (7 node types, 7 relationship verbs) is declared in
`schema/dual-brain.json` and validated by G-brain's real schema-pack parser.

### 10. The condense pass — `src/condense-cluster.ts` + `scripts/live-condense*.ts`

The emara instinct: clean the nonsense, feed the model one condensed piece.
Deterministic clustering by shared signals (npm scripts, docker commands,
node --test files, python invocations, skill-doc paths, polling patterns —
with truncation-tolerant normalization so SKILL/SKILL.md/SKIL collapse). Each
multi-member cluster gets ONE reviewer call to merge variants into one
canonical record. Variants are superseded: currency -> 'superseded' plus a
`supersedes` edge from the canonical. History is preserved — supersession is
not deletion.

Reality check: 247 -> 112 active after two passes (23 clusters merged,
158 variants superseded).

### 11. The briefing — `projectBriefing()` + `scripts/session-start.ts`

Retrieval: project page -> backlinks (real graph walk) -> active records only
-> rendered handoff: procedures first ("How to work here"), then findings.
Writes `<project>/.hermes-memory/BRIEFING.md`, or stdout with --stdout.

### 12. The wiring — `~/.codex/AGENTS.md`

Tells Codex at session start to read `.hermes-memory/BRIEFING.md` if present.
The briefing is declared data, not authority: current instructions override it.
ACCEPTANCE TEST (passed 2026-10-08): fresh Codex session in software-auditor
answered "how do I run tests" from the briefing — including the
scanner-test-file example — and verified against package.json instead of
blindly trusting. It even answered for the *other checkout* correctly, because
both map to the same project identity.

### 13. Session-end capture (built 2026-10-11) — `src/capture-cursor.ts` + `src/session-capture.ts`

The cycle-closer. A durable cursor (`live-run/capture-cursor.json`) records
every processed rollout by identity — path + mtime + size — so a session that
grew (appended turns) is NEW again. `bun scripts/session-capture.ts` walks
`~/.codex/sessions`, captures only unseen/changed rollouts through the same
parse → ledger → redact chain, appends passed candidates to
`live-run/capture-queue.jsonl`, advances the cursor. `--dry-run` previews
without writes; `--baseline <iso-cutoff>` adopts an already-reviewed corpus
without queuing (used to adopt the 123 backfilled sessions, cutoff
2026-10-08). Deterministic and free: no reviewer calls here.

### 14. Queue review (built 2026-10-11) — `scripts/queue-review.ts`

The manual paid gate. Reads the capture queue, skips excluded and
already-reviewed lines, reserves budget per call ($0.05 cap), calls the
reviewer (throttled 1.5s — the rate-limit fix), writes validated records via
the normal writer (never wipes the brain), marks each queue line with its
outcome, and appends a durable report (`live-run/queue-review-report.jsonl`).
Re-runs are idempotent. First live run: 4 candidates → 1 saved
(session-scoped write_stdin procedure), 3 NOT_WORTH_SAVING, 0 failed, $0.015.

## Where everything physically lives

- Repo: `C:\Users/dev\Development\Local\dual-brain-memory`
  (private GitHub: mohamedswe/dual-brain-memory)
- The brain (disposable): `live-run/brain.pglite` — 270 records
  (112 active, 158 superseded) + project pages + belongs_to/supersedes edges
- Budget ledger: `live-run/ledger.db` — ~$6.85 spent of the $10 monthly cap
- Briefing (software-auditor):
  `C:\Users/dev\~/Desktop\software-auditor\.hermes-memory\BRIEFING.md`
- Codex wiring: `C:\Users/dev\.codex\AGENTS.md` (backup: AGENTS.md.bak)
- Original design: `C:\Users/dev\.hermes\plans\2026-10-03_013735-dual-brain-memory-design.md`
- Tests: 61 across 18 files — run with `npm run test`

## Operating manual (the commands)

- Generate a briefing: `bun scripts/session-start.ts <project-dir>`
- View it: `bun scripts/session-start.ts <project-dir> --stdout`
- Inventory all memories: `bun scripts/inventory.ts`
- Count active vs superseded: `bun scripts/count-active.ts`
- Export fresh candidates: `bun scripts/export-candidates.ts <sessions-root> <out.jsonl>`
- Full backfill (paid, legacy): `bun scripts/live-backfill.ts`
- Retry failures (paid, legacy): `bun scripts/live-retry.ts`
- Condense (paid): `bun scripts/live-condense.ts`, then `...-retry.ts`
- **Capture new sessions (free, deterministic): `bun scripts/session-capture.ts`**
  — incremental; only sessions not in the cursor. `--dry-run` to preview.
  `--baseline <iso-date>` adopts a pre-existing corpus without queuing.
- **Push the queue through the reviewer (paid, per-run go): `bun scripts/queue-review.ts`**
  — `--dry-run` first; `--limit N` to bound spend. Throttled 1.5s/call.
- Eval tooling: `bun scripts/eval-score.ts <rollouts...>` (token/tool/time
  comparison), `bun scripts/eval-collect.ts <run-dir> [since-days]` (archive
  rollouts + events dumps + index.json into the eval run dir)
- Run the tests: `npm run test`

## What is NOT built (honest boundaries)

1. ~~**It's a snapshot, not a cycle.**~~ The session-end capture lane is
   BUILT (2026-10-11): `bun scripts/session-capture.ts` walks new sessions
   incrementally (cursor at `live-run/capture-cursor.json`), queues redacted
   candidates to `live-run/capture-queue.jsonl`, and `bun scripts/queue-review.ts`
   pushes them through the paid reviewer into the brain (manual per-run go).
   The cycle is closed, but capture does not run automatically — it is a
   command, not a daemon (deliberate).
2. **The disposable brain is not Codex's real brain.** `~/.codex/gbrain/`
   is untouched. Migration is a separate explicit authorization.
3. **Hermes side is unbuilt.** No Hermes capture loop, no cross-brain reads
   exercised (the contract supports them; nothing uses them yet).
4. **No embeddings.** Paraphrase duplicates without shared commands/paths
   remain (~30 of the 112 actives).
5. **The history lane is unbuilt.** Repetition can only surface procedures.
   Decisions, failed attempts, "what happened over the project" need
   session-level review (once-but-critical knowledge).
6. **No transport/auth.** In-process trusted identities only; no network
   service is exposed. PGLite is single-process by nature.
7. Loose ends: 2 condense clusters still failing (docker-compose, build:graph);
   budget reset convention undecided (~$3.13 remaining of the October cap).

## The cost model (observed)

- Reviewer backfill: ~$0.002-0.05 per candidate (reasoning tokens dominate)
- Condense: ~$0.003 per cluster
- Everything deterministic (ledger, redaction, clustering, briefing): free
- Full corpus so far: $6.85 of $10 monthly cap
