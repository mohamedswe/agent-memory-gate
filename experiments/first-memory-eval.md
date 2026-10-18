# First dual-brain evaluation: procedural rediscovery (offline setup)

This is a **pilot**, not evidence of lifelong learning. It asks whether a Codex session given the existing dual-brain briefing finds and runs a focused test with less rediscovery than a fresh session without it. The briefing is a snapshot from a *different, older checkout* and contains stale paths/noisy polling advice: watch for negative effects, not only speedups.

## Prepared snapshots

`../.eval-local/first-valid/` has `baseline/` and `memory/`, exported from the same clean `software-auditor` Git commit. Only `memory/.hermes-memory/BRIEFING.md` differs. `manifest.json` records the commit, briefing hash and task; `TASK.txt` is the identical task to paste into both sessions. No live brain was modified. Do **not** use `.eval-local/first-run`: it contains an earlier pilot task blocked by missing `tree-sitter` in both conditions.

## Run when you choose to spend agent usage

1. Start a **fresh Codex session** with working directory `../.eval-local/first-valid/baseline`. Paste `TASK.txt` verbatim. Do not give it this protocol, the manifest, the other workspace, or previous session context. Save the full transcript privately.
2. Start another fresh session with working directory `../.eval-local/first-valid/memory`. Paste the **same** `TASK.txt`. Save its transcript privately. If possible, use the same model, tool permissions and time/token limit. Do not run both from the `dual-brain-memory` parent directory, which exposes both conditions.
3. Score independently: did the test actually execute and pass; did it identify the correct command; how many exploratory reads/searches or repeated calls; elapsed time and tokens/cost if the client reports them; any stale briefing advice followed; whether the limitation of the test was stated accurately. A model *saying* it passed is not evidence; check tool exit output. Keep raw transcripts out of Git.
4. Repeat on several independently chosen tasks before claiming a trend. One run per condition is a smoke test, not a robust performance result. Alternate condition order across later tasks. A short hand-written project note is a useful third condition before concluding the full memory pipeline earns its complexity.

Both snapshots were locally verified: `node --experimental-strip-types --test src/contract/contractCorrection.test.mjs` passed 1/1 in each. The original repository has no installed `tree-sitter`, so the earlier proposed coverage-investigation test cannot serve as this pilot's task. This does **not** imply the agent runs have happened.

## Recreate without overwriting

From the `dual-brain-memory` repo, choose a NEW out directory each time:

```bash
python3 scripts/setup-memory-eval.py \
  --repo C:/Users/dev/Development/GitHub/software-auditor \
  --briefing ~/Desktop/software-auditor/.hermes-memory/BRIEFING.md \
  --out .eval-local/run-02
```

This exports tracked HEAD only; local edits/untracked files are deliberately excluded. It performs no API calls or dependency installs. The global Codex `AGENTS.md` tells Codex to read a briefing when one exists; its other instructions still apply in both conditions. If Codex cannot select these directories as working directories, do not improvise a run in the live checkout: stop and adjust the protocol first.

## Result: first-valid pilot (2026-10-11) — TIE

Both conditions found and ran `node --experimental-strip-types --test src/contract/contractCorrection.test.mjs` (passed 1/1). Measured via rollout JSONL (`~/.codex/sessions/2026/10/11/`, scored with `scripts/eval-score.ts`):

| metric | baseline | memory |
|---|---|---|
| input tokens (uncached) | 79,793 (13,617) | 83,243 (13,867) |
| output tokens | 466 | 449 |
| tool calls | 3 | 3 |
| wall time | ~26s | ~20s |

Verdict: the task was too easy to discriminate — the test file is one `rg` away in the repo itself, so the briefing had no room to save steps. This is a smoke test only (one run per condition). No stale briefing advice was followed. Session-start briefings and `scripts/eval-score.ts` now exist; next step is a task whose answer lives only in the briefing (e.g. graph determinism verification procedure).

**Next, distinct question:** Once session-level capture exists, evaluate whether a *specific evidenced failed attempt* from session A prevents the same failure in session B, versus no memory and a simple human note. Current repetition-gated memories mostly describe procedures, so this pilot cannot prove longitudinal improvement.

## Run 02 prepared (2026-10-11): graph determinism task

`.eval-local/run-02/` — same commit, same briefing snapshot, NEW task: "Verify that this project's dependency graph build is deterministic. Produce evidence..." The README claims determinism but not how to verify it; the briefing contains the exact procedure (build twice, compare SHA256 of graph.json). This task can discriminate conditions.

Setup changes: `setup-memory-eval.py` now takes `--task-file`, `--task-label`, and `--with-deps` (copies source-repo `node_modules` into both snapshots, `.bin` excluded, so the offline graph build works; verified: 256 files / 3611 edges built inside the snapshot). `npm install` was run once in the GitHub source repo for this. Score runs with `bun scripts/eval-score.ts <rollouts>`.

## Result: run-02 (2026-10-11) — memory slightly cheaper, slower, more compliant

Both conditions verified graph determinism correctly (3 builds, byte-identical, SHA-256 match, honest limitations stated). Scored via `scripts/eval-score.ts`:

| metric | baseline | memory |
|---|---|---|
| total tokens | 372,443 | 354,502 |
| uncached input | 35,582 | 32,901 (-7.5%) |
| output tokens | 3,677 | 4,673 (+27%) |
| tool calls | 9 | 10 |
| wall time | 121s | 146s |

Findings: memory cheaper on uncached input but slower and more verbose (extra evidence packaging, one mid-run recovery). Behavioral divergence in memory's favor: baseline violated the workspace-only constraint (read an external skill file) and used plain npm; memory used `npm --offline --ignore-scripts` and stayed in-workspace. No stale briefing advice followed. Method still converged — determinism verification is derivable, so the task only partially discriminated. Next: repeat runs with alternating condition order before concluding anything.

## Run 03 prepared (2026-10-11): repeatability protocol — 3 paired runs, alternating order

Workspaces: `.eval-local/run-03-rep1/` (baseline first), `run-03-rep2/` (memory first), `run-03-rep3/` (baseline first). Same determinism task as run-02, same commit, same briefing snapshot. Each manifest carries a `replication` block (rep number, order).

**Data capture (new, `scripts/eval-collect.ts`):** after both sessions of a rep finish, run
`bun scripts/eval-collect.ts <run-dir>` — it finds the rollouts by working directory, archives raw JSONL + human-readable events dump into `<run>/transcripts/<condition>/`, and writes `index.json` with token/tool counts and SHA-256 file hashes. Validated against run-02: collector numbers match eval-score.ts exactly. Re-run 02 has its transcripts archived under `.eval-local/run-02/transcripts/`.

Protocol per rep: fresh Codex session in each condition workspace (order per manifest), paste `TASK.txt` verbatim, then collect. After all 3 reps: score pairs with eval-score.ts, look for a *consistent direction* of the uncached-input gap across reps; 3 same-direction results is the minimum before believing any delta.

## Run 04 prepared (2026-10-11): stale-advice trap — the negative test

Purpose: all previous runs measure benefit (tokens/compliance). Run-04 measures HARM: does the briefing's stale content (dead external paths like C:/Users/dev/determinism-check/, external Desktop checkout paths, PowerShell node-process polling habits) get followed instead of workspace reality?

Task (all 3 reps): "This project has an ongoing determinism investigation. Report the current status: what has already been verified, whether any determinism-check runs are still in progress or pending, and what evidence exists. Inspect only this workspace and any briefing..." — deliberately ambiguous wording that tempts toward the briefing's stale determinism-check memories.

Scoring: for each memory run, count (a) commands touching stale external paths, (b) polling/Get-Process habits copied from briefing, (c) whether the run correctly concluded there is no live investigation in the workspace. Baseline serves as control for what a fresh agent does with the same ambiguous ask.

Workspaces: run-04-rep1 (baseline first), rep2 (memory first), rep3 (baseline first). Deps included (--with-deps). Same briefing snapshot (sha f4a873bd...).

## Result: run-04 (2026-10-11) — memory survives the stale-advice trap

3 paired reps (order alternated). Task: ambiguous "determinism investigation status" designed to tempt toward briefing's dead external paths.

**Primary: ZERO stale commands executed in all 6 runs.** The briefing's dead paths (C:/Users/dev/determinism-check/, external Desktop checkout, Get-Process polling habits, write_stdin/yield_time habits) appear only in briefing text the memory agent read, never in executed commands. 3/3 memory runs stayed in-workspace.

**Conclusions:** 5/6 runs correctly concluded no live/completed investigation (memory-rep2's "unresolved" phrasing scored borderline). Both conditions independently grounded answers in the workspace's real historical artifacts (five `variance` audit runs in audit-results/, 84-94% coverage spread, all exit 2).

**Uncached input:** baseline 40.0k/34.9k/40.2k vs memory 28.3k/27.5k/40.2k — memory -17% mean, 2/3 in its favor; memory-rep3 was an outlier (+1%) with elevated total input (198k). Tool calls: memory 3/3/5 vs baseline 5/4/4.

> **Correction (2026-10-18), from the session records:** the paragraph below is wrong on three points. Kept as originally written for the record.
>
> 1. **There are 7 executed pairs, not 9.** Run 03's three reps were prepared but never run: `.eval-local/run-03-rep{1,2,3}/index.json` all have `"sessions": []` and no Codex rollout has those workspaces as its working directory. Run 02 was instead run three times in `.eval-local/run-02/` (pairs at 23:10, 23:27–23:30 and 23:32 UTC), and those were counted again as "run 03". Executed pairs: run 01 ×1, run 02 ×3, run 04 ×3.
> 2. **Uncached-input deltas (memory vs baseline):** run 01 +1.8%; run 02 −7.5%, −28.3%, −20.0%; run 04 −29.3%, −21.2%, +14.6%. Memory was lower in 5 of 7 (median −20.0%, mean −12.8%). Run 04 rep 3 was mis-transcribed above: its baseline used 35,100 uncached tokens, not 40.2k, so memory was +14.6%, not +1%.
> 3. **Compliance:** memory used `npm --offline --ignore-scripts` in 2 of run 02's 3 memory runs (rep 3 ran plain `npm run build:graph`), not 3/3. Baseline used it 0/3; one baseline run (rep 1) read a file outside its workspace.
>
> Per-session figures and rollout file names: `experiments/runs-01-06-summary.json`.

**Cross-eval picture after 9 pairs (runs 01-04):** briefing consistently saves ~10-20% uncached input; improves protocol discipline (offline/ignore-scripts 3/3 vs 0/3 in run-02/03 batch); NEVER changed correctness (methods converge in every task); no measurable speed effect; and survives a baited staleness trap. Memory = efficiency + discipline, not capability.

## Run 05 prepared (2026-10-12): the LONGITUDINAL test — failure knowledge vs fresh sessions

The design doc's real question: does an evidenced failure from session A get avoided in session B? The failure is real and machine-captured: heredoc TS corruption (3 hits 2026-10-11, record 146ac993 in the disposable brain, rendered into HISTORY.md).

Task: "Create scripts/path-check.ts with toPosix(p) (backslash regex normalization) + 3 bun tests, run them, report." The task tempts exactly the recorded failure: any agent creating the file via `cat <<EOF` in git-bash corrupts the escapes.

Three conditions (fresh software-auditor exports, identical commit):
- run-05-baseline: nothing
- run-05-note: NOTE.md, hand-written by the operator (the third condition per the original protocol)
- run-05-memory: .hermes-memory/ (BRIEFING.md + HISTORY.md) with the captured failure record

Scoring: (a) file-creation method per condition (heredoc vs direct write — from tool calls, not claims), (b) whether tests pass first try, (c) recovery cost if the failure hits (steps to fix), (d) token/tool cost. Predictions: baseline hits the trap or writes it safely by luck; note avoids it (explicit, human-tuned); memory avoids it only if HISTORY.md is actually read — that is the claim under test.

## Result: runs 05–06 (2026-10-11, local evening) — NULL (written up 2026-10-18 from session records)

Both runs had three conditions on fresh exports of the same commit: **baseline** (nothing), **note** (hand-written `NOTE.md` at the workspace root) and **memory** (`.project-memory/BRIEFING.md` + `HISTORY.md` with a seeded failure record). One session per condition.

**Run 05 — heredoc trap.** Task: create `scripts/path-check.ts` (a `toPosix` backslash normalizer using a regex with backslash escapes) plus 3 bun tests, run them and report.

| condition | uncached input | total input | output | tool calls | wall | file creation | tests first try | memory/note read? |
|---|---|---|---|---|---|---|---|---|
| baseline | 11,805 | 69,405 | 832 | 3 | 48s | patch tool | yes (3/3) | n/a |
| note | 10,388 | 68,884 | 957 | 3 | 46s | patch tool | yes (3/3) | **no** — `NOTE.md` present but never opened |
| memory | 11,909 | 106,885 | 1,036 | 5 | 53s | patch tool | yes (3/3) | yes — BRIEFING + HISTORY read in call 1 |

Verdict: **the trap could not fire.** Every condition created files with Codex's patch tool, never a shell heredoc, so the recorded heredoc failure was irrelevant to how this agent writes files. Memory was read and cost +0.9% uncached / +54% total input for no behavioural difference.

**Run 06 — test-import trap.** Task: add `test/pathUtils.test.ts` with at least 3 tests for the export in `src/graph/persistRepositoryGraph.ts`, without modifying existing files, run it and report.

| condition | uncached input | total input | output | tool calls | wall | tests first try | memory/note read? |
|---|---|---|---|---|---|---|---|
| baseline | 10,766 | 118,158 | 1,147 | 5 | 58s | yes (4 pass) | n/a |
| note | 14,458 | 149,370 | 1,817 | 6 | 77s | yes (4 pass; also ran full suite, 159 pass) | **yes** — `NOTE.md` read in call 3 |
| memory | 25,361 | 133,137 | 1,610 | 5 | 65s | yes (4 pass; also ran full suite, 159 pass) | yes — BRIEFING + HISTORY read in call 1 |

Verdict: **no correctness difference, and memory cost more** (+136% uncached vs baseline; the note condition +34%). Both primed conditions chose to run the full test suite as well, which the baseline skipped.

**What these runs establish:**
- Short artificial traps do not test longitudinal memory: competent agents solve them from the repo, and a trap must match how the agent actually works (this agent never uses heredocs).
- Reading memory has a real cost and can change behaviour in ways that cost more, not less.
- `NOTE.md` at the workspace root was ignored in run 05 but read in run 06, so whether an unreferenced file is read is inconsistent. A hand-written-note baseline must be wired exactly like the memory files.

Source rollouts are listed in `experiments/runs-01-06-summary.json`.

## Run 07 prepared (2026-10-12): the REALISTIC loop test — build work, capture, reuse

Runs 05-06 verdict: invented micro-traps fail because competent agents derive everything from the repo; the longitudinal claim needs realistic work where accumulated memory has real content. Run-07 is the loop operating on itself:

- PHASE 1 (baseline, memory-generating): fresh agent, NO project memory, builds a real feature (redaction-report stage: queue -> markdown summary) in a flat export of dual-brain-memory at e64d0ad. Its transcript — with real rediscoveries (canonical-runner rule, test conventions, queue shape) — feeds session-capture -> queue-review -> briefing.
- PHASE 2 (memory, ~same repo state): fresh agent, second realistic task, WITH the briefing rendered from phase-1 capture. Measures: does phase 2 skip phase-1's discovery costs?
- Score: discovery cost (uncached tokens, tools, files read before writing) phase-1 vs phase-2; canonical suite green both phases; procedures harvested by capture (the actual briefing delta).

Honest asymmetry (accepted): phase 2 benefits from phase 1's labor — that is what memory is for. The measurable is cost saved, not fairness.

## Run 07 result (2026-10-12): the realistic loop test — PASSED with a finding

Phase 1 (baseline, no memory): built redaction-report stage. Canonical 114 pass, suite wired (no false green), report verified by controller against crafted + real queues. Cost: 43,498 uncached / 7 tools / 3 discovery reads. Zero repetition candidates captured (one-pass work — the ledger honestly had nothing to harvest).

Phase 2 (memory: BRIEFING 0 procedures + HISTORY with milestones + heredoc record): built queue-stats stage, same shape. Canonical 120 pass, suite wired, stats output exactly matches queue truth. Cost: 30,826 uncached (-29%) / 7 tools. Read BRIEFING + HISTORY unprompted via AGENTS.md wiring.

Verdict: the full loop (work -> capture -> review -> attribution -> render -> consume) works end-to-end on real work, and captured memory saved 29% uncached input on a realistic build task. Correctness tied (both phases avoided the false-green trap by reading the repo).

Findings:
1. The repetition gate starves BRIEFING on one-pass work — procedures only accumulate from multi-pass rediscovery sessions. Phase 2's savings came from HISTORY context, not procedures.
2. Attribution was the loop's self-found bug: 45/47 marker records landed in projects/unknown (Hermes chats carry no cwd). Fixed: hermes-attribution.ts + curated map + repair (22 re-attributed; 23 career/untitled sessions stay honestly unknown). 5 tests.
3. Memory consumption is wiring-dependent and works: both eval conditions read .project-memory unprompted. (Run-05 also proved the inverse: an unwired NOTE.md at workspace root was never read.)
