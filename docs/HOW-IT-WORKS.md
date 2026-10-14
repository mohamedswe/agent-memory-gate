# How everything works — the complete walkthrough

Written 2026-10-08, after the acceptance test passed (a fresh Codex session
answered "how do I run tests" from the briefing). Updated 2026-10-14 with the
cross-session lane (1b), the satisfaction lane (2), the Hermes adapter, and
HISTORY.md (stages 15–19). This is the full, honest picture: what runs, in
what order, what enforces what, and what is NOT built.

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

Since 2026-10-11 there are two more signals: a key that appears once in many
sessions of the same project (cross-session repetition), and the user's
satisfaction arc across a conversation (Codex and Hermes), whose transitions
become dated markers rendered into a second file, HISTORY.md.

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
Writes `<project>/.project-memory/BRIEFING.md` (plus `HISTORY.md`, stage 18),
or stdout with --stdout. (Renamed from `.hermes-memory/` on 2026-10-11: the
memory is project-scoped, not agent-scoped.)

### 12. The wiring — `~/.codex/AGENTS.md`

Tells Codex at session start to read `.project-memory/BRIEFING.md` (and
`HISTORY.md`) if present, and how to render it if missing.
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
Since 2026-10-11 it also handles satisfaction jobs (stage 17) and
cross-session candidates (stage 16) in the same run.

### 15. The injection filter — `src/injection-filter.ts`

Codex rollouts carry system-injected "user" messages: `<environment_context>`,
AGENTS.md instruction wrappers, plugin recommendations, resumed history. A
real-data census found them polluting both the key space and the satisfaction
trajectories. One shape-matched filter, shared by every lane, drops them at
observation time.

### 16. Cross-session repetition (lane 1b, built 2026-10-12) — `src/cross-session-ledger.ts`

The within-session gate structurally cannot see the textbook durable
procedure: a command that appears ONCE in EVERY session (never ≥2 within
one). The cross-session ledger counts DISTINCT SESSIONS per key, scoped per
project (a key repeating across different projects is a generic habit, not
project knowledge). At ≥2 distinct sessions the key is queued with
`crossSession: true` provenance, then added to a promoted-set so it is never
re-queued (the start command would otherwise be re-paid forever). State is
durable JSON (`live-run/cross-session-ledger.json`); a corrupt file falls back
to fresh (re-observe, never silently skip).

Reality check: census over 146 real sessions → 55 promotions (docker compose
test builds, `git safe.directory`, skill-doc reads); review saved 41.
Known limit: keys are exact strings including incidental args, so only 57 of
12,056 observed keys have crossed.

### 17. Satisfaction lane (lane 2, built 2026-10-11) — `src/session-trajectory.ts`, `src/satisfaction-classifier.ts`, `src/satisfaction-transitions.ts`

Repetition can only surface procedures. Lane 2 uses a different signal:
the user's reaction. Capture extracts the user-turn sequence for free (one
satisfaction job per session with real user turns). Review makes ONE
batched paid call per session that labels every turn pleased / neutral /
displeased — same discipline as the reviewer (reserve → call → reconcile →
strict validation, exactly one verdict per turn, reasoning fallback;
max_tokens 6000 because reasoning burn emptied content at 1600). The
classifier never decides what to remember. Deterministic transition
detection then finds:

- **milestone** — neutral → pleased
- **recovery** — displeased → pleased
- **regression** — pleased → displeased
- **unresolved** — displeased run that lasts to session end

Observed cost: ~$0.018 for a 24-turn session. Finding: Codex usage is mostly
one-prompt-per-session, so arcs live in Hermes conversations.

### 18. Hermes adapter + attribution + HISTORY.md — `src/hermes-adapter.ts`, `src/hermes-attribution.ts`, `src/marker-records.ts`, `src/history-renderer.ts`

`bun scripts/hermes-capture.ts` reads the Hermes session store (`state.db`)
and queues satisfaction jobs, incremental by session id + last message id.
Hermes chats carry no cwd, so run-07 found 45/47 marker records landing in
`projects/unknown`. Attribution resolves sessions to projects via an
operator-curated longest-prefix map (`live-run/hermes-project-map.json`);
cwd always wins; unmapped stays honestly `unknown`, never guessed.

Each transition becomes a marker record (kind `attempt`, proposed/tentative,
the user's own turns quoted — no invention), written via the normal writer.
`session-start.ts` renders them chronologically into
`<project>/.project-memory/HISTORY.md` next to BRIEFING.md.
Known limit: markers record *when* the user reacted, not *what* was learned;
most entries are quote fragments, and dates are capture dates.

### 19. Public export architecture

This repository is maintained as a clean, sanitized export of the research system:
username rewritten to `Users/dev` preserving path structure (test fixtures
depend on it), private session-derived data and personal notes excluded,
run-08 raw data included with 13 automated evidence verification tests (`tests-run08/`).
All 122 unit tests and 13 evidence tests pass in this export.

## Where everything physically lives

- Repo: `https://github.com/mohamedswe/agent-memory-gate`
- The brain (disposable): `live-run/brain.pglite` — 371 records
  (213 active, 158 superseded) + project pages + belongs_to/supersedes edges
- Budget ledger: `live-run/ledger.db` — $7.32 spent of the $10 October cap
  (983 reservations, 0 held)
- Capture state: `live-run/capture-cursor.json`, `hermes-capture-cursor.json`,
  `cross-session-ledger.json`, `capture-queue.jsonl`,
  `satisfaction-verdicts.jsonl`, `queue-review-report.jsonl`
- Briefings: `<project>/.project-memory/BRIEFING.md` + `HISTORY.md` for
  software-auditor (58 procedures), Insectflux-dev (28), emara-release,
  dual-brain-memory
- Codex wiring: `~/.codex/AGENTS.md`
- Original design: `~/.hermes/plans/2026-10-03_013735-dual-brain-memory-design.md`
- Tests: 122 across 27 files — run with `bun run test`

## Operating manual (the commands)

- Generate a briefing + history: `bun scripts/session-start.ts <project-dir>`
- View it: `bun scripts/session-start.ts <project-dir> --stdout`
- Inventory all memories: `bun scripts/inventory.ts`
- Count active vs superseded: `bun scripts/count-active.ts`
- Export fresh candidates: `bun scripts/export-candidates.ts <sessions-root> <out.jsonl>`
- Full backfill (paid, legacy): `bun scripts/live-backfill.ts`
- Retry failures (paid, legacy): `bun scripts/live-retry.ts`
- Condense (paid): `bun scripts/live-condense.ts`, then `...-retry.ts`
- **Capture new Codex sessions (free, deterministic): `bun scripts/session-capture.ts`**
  — incremental; lanes 1a + 1b + satisfaction jobs. `--dry-run` to preview.
  `--baseline <iso-date>` adopts a pre-existing corpus without queuing.
- **Capture Hermes sessions (free): `bun scripts/hermes-capture.ts`**
  — `--session <id-prefix>` for one session, `--dry-run` to preview.
- **Push the queue through the paid stages (per-run go): `bun scripts/queue-review.ts`**
  — `--dry-run` first; `--limit N` to bound spend. Throttled 1.5s/call.
- Eval tooling: `bun scripts/eval-score.ts <rollouts...>` (token/tool/time
  comparison), `bun scripts/eval-collect.ts <run-dir> [since-days]` (archive
  rollouts + events dumps + index.json into the eval run dir),
  `python scripts/setup-memory-eval.py` (paired workspaces; `--flat`, `--with-deps`)
- Run the tests: `bun run test`

## What is NOT built (honest boundaries)

1. **Capture is a command, not a daemon** (deliberate). Review stays a manual,
   per-run paid go.
2. **The disposable brain is not Codex's real brain.** `~/.codex/gbrain/`
   is untouched. Migration is a separate explicit authorization.
3. **No cross-brain reads exercised.** The contract supports them; nothing
   uses them yet. Hermes capture exists (stage 18) but only feeds lane 2.
4. **No embeddings.** Paraphrase duplicates without shared commands/paths
   remain; cross-session matching is exact-string.
5. **Once-but-critical knowledge is still mostly missed.** Lane 2 marks
   *when* something mattered, not *what* was learned. Turning transitions
   into decision / failed-attempt / correction records is the open step —
   and the fix for one-pass starvation.
6. **No transport/auth.** In-process trusted identities only; no network
   service is exposed. PGLite is single-process by nature.
7. Loose ends: 2 condense clusters still failing (docker-compose, build:graph);
   5 reasoning-burn NO_CONTENT retryables; budget reset convention undecided
   (~$2.68 remaining of the October cap).

## The cost model (observed)

- Reviewer: ~$0.002-0.05 per candidate (reasoning tokens dominate)
- Satisfaction classifier: ~$0.02 per multi-turn session (one batched call)
- Condense: ~$0.003 per cluster
- Everything deterministic (ledgers, filters, redaction, clustering,
  attribution, rendering): free
- Everything so far: $7.32 of $10 monthly cap
- For contrast (run-08): A-MEM pays ~1,100 write tokens per note,
  unconditionally
