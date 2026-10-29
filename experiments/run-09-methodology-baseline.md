# Run 09: methodology baseline and capture failure

Completed 2026-10-27 using the user's explicitly authorized ChatGPT/Codex plan.
**No added value from automatic memory was established.** All nine development
runs passed automated acceptance, but onboarding generated zero learned records.
This is an engineering pilot, not evidence of general developer productivity.

## Observed results

| Condition | Automated acceptance | Execution tokens | Formation tokens | Tokens per passing patch |
| --- | --- | --- | --- | --- |
| Baseline: existing repo context | 3/3 | 68,149 | 0 | 22,716 |
| Static project note | 3/3 | 68,805 | 0* | 22,935 |
| Automatic memory, empty | 3/3 | 79,432 | 21,522 | 33,651 |

The preselected primary token measure is **uncached input plus output**, including
failed measured attempts and automatic-memory formation. It is not a price or
plan-credit estimate. *The static note was AI-assisted; human authoring and
maintenance effort were not measured, so zero here is not a claim of free upkeep.*

All runs passed the original 123-test suite, their hidden task checks, and their
new regression tests. No existing tests or launcher files were modified. These
are provisional automated acceptances, not independent human reviews.

The memory condition consumed about 48% more primary tokens per passing patch
in this sample, including onboarding. Because it contained no learned records,
differences from baseline cannot establish the effect of useful learned
guidance. Static-note primary tokens were approximately flat versus baseline.

Metric sensitivity matters: the static-note condition consumed 354,501 total
input/output tokens versus baseline's 483,509, despite similar primary token
totals. Cache behavior therefore changes the apparent result. With one attempt
per condition per task, we cannot separate a treatment effect from stochastic
agent behavior or caching. No significance claim is made.

## The actionable finding

Two valid onboarding sessions inspected the same four project files and both
executed all 123 tests successfully, without changing source. The existing
repetition gate promoted **zero candidates**:

- One session used `bun scripts/test.ts`; the other used equivalent
  `bun run test`. The package maps both to the same test launcher.
- One read files in a batched PowerShell command; the other used separate
  `Get-Content -LiteralPath` calls.

Exact command-string identity missed those behavioral repetitions. No manual
memories were inserted to rescue the treatment; the empty result was retained.

An [offline exploratory replay](run-09-data/gate-replay.json) recognizes only
these simple observed syntactic variants and finds five repeated-action
candidates: four file reads and the test command. This is **not** five validated
useful memories, and no downstream task benefit has been measured. Production
gate behavior and the nine-run treatment were not changed by this replay.

## Protocol and controls

- Frozen source: `09a1ef67fb8911ec37fb63e1799ecce39aed6428`. Identical file
  fingerprints were checked before every measured run. Uncommitted source,
  private session logs, and live project memory were excluded.
- Three preselected real defects: foreign satisfaction-verdict indices,
  recovery across neutral messages, and rollout items without IDs.
- Each defect ran once in baseline, static-note and automatic-memory conditions.
  The randomized order was recorded before inference and retained throughout.
- Native `codex exec`: `gpt-6.1-sol`, high reasoning, fresh ephemeral sessions,
  ChatGPT authentication required, API-key overrides cleared, external web and
  subagents disabled, and the same startup-context slot in every condition.
- The native protocol replaced the unexecuted Nous protocol before any measured
  result. Plan sessions expose token counters but no per-run dollar charge.
- Each task's hidden evaluator failed on the original source for the intended
  defect. An isolated reference fix passed it and preserved all original tests.
- Automatic memory used the existing reader, usage ledger, cross-session gate,
  redaction, record contract, disposable PGLite store and project retrieval.
  There were no candidates to review. Satisfaction learning was outside scope:
  onboarding had one instruction per session and no human reaction.
- Up to twelve candidates could be reviewed in lexical order, without manual
  rewriting. The overall limits were nine measured sessions, two valid onboarding
  sessions, twelve reviews, twenty-four sessions and two million observed tokens,
  checked between sessions, with a five-minute session timeout.

## Methodology defects and retained overhead

Before the valid cohort, three onboarding attempts could inspect files but were
blocked from running tests by never-approval settings. They are preserved as
infrastructure diagnostics: 209,021 total input/output tokens, of which 41,725
were uncached input plus output. They are reported separately from valid memory
formation and measured task runs. Generic connectivity probes and developer
setup effort are not included in those diagnostic totals.

The valid cohort used Codex's documented automatic approval-review flow while
retaining the workspace sandbox. Background approval-review usage absent from
CLI counters is unmeasured. A generic earlier Nous connectivity probe cost
$0.00002951; no Nous comparative or memory-formation calls were used.

Trace review found that `git status` could discover the parent checkout and
expose its changed filenames. That weakens isolation and the performance
interpretation. After the trial, the runner was hardened to clear inherited
Git-root variables and prevent parent discovery. A real nested-Git regression
test verifies the fix. The fix is not retroactively applied to the measured
results, and no additional inference runs were launched to replace them.

The original harness is archived locally and its hashes, patch hashes, acceptance
file hashes, acceptance decisions and summary arithmetic are checked on export.
Completed run identities cannot silently launch new model sessions.

## Evidence and reproduction

- [Frozen native manifest](run-09-data/codex-manifest.json)
- [Per-run results and aggregate metrics](run-09-data/codex-results.json)
- [Original negative and positive control evidence](run-09-data/preflight.json)
- [Offline gate replay](run-09-data/gate-replay.json)
- [Task prompts and hidden acceptance definitions](value-v1-tasks.ts)

Raw prompts, Codex events, patches, stdout/stderr and original harness snapshots
remain under `.eval-local/value-codex-v3/`, ignored by Git. Earlier permission
diagnostics remain under `value-codex-v1` and `value-codex-v2`.

```powershell
bun run test                     # implementation and measurement tests; offline
bun run eval:controls            # original defect/reference-fix controls; offline
bun run eval:report              # read the completed trial; no inference
bun scripts/export-codex-trial.ts # audit and export recorded results; no inference
bun scripts/analyze-run09-gate.ts # restricted offline normalization replay
```

The final implementation suite has 143 passing tests; all fourteen historical
Python evidence checks pass. The latter check stored Run 08 arithmetic and
documentation consistency, not causal performance.

## Decision

Do not expand the architecture based on this pilot. First make command identity
robust to safe, equivalent invocation forms, then verify that natural prior
sessions yield supported, useful memories. Evaluate the resulting system on
new held-out development tasks with stronger Git isolation and repeated runs.
The prospective two-repository and everyday-use study remains specified in
[VALUE-VALIDATION.md](../docs/VALUE-VALIDATION.md).

This trial establishes a working measurement path and identifies a capture
failure. It does not prove everyday usefulness, general quality equivalence,
or a reliable productivity effect.
