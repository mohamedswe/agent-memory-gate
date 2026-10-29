# Run 10: Codex follow-up after the capture fix

2026-10-27. Status: complete (nine of nine comparisons). This follows Run 09 with corrected
action capture and a required nonempty, source-supported memory treatment.
All inference uses the explicitly authorized ChatGPT/Codex plan, not Nous or
API-key billing. Per-session dollar cost is unavailable.

## Manipulation check

The two original successful onboarding transcripts were replayed unchanged
through the fixed capture code with their pinned package manifest. Their hashes
are in the [frozen manifest](run-10-data/codex-manifest.json).

Five repeated-action candidates reached review. Native Codex retained one:

> In project: tests have been invoked with `bun scripts/test.ts` and `bun run test`.

The record remains proposed/tentative. Its command and two-session provenance
are supported by the frozen project and recorded executions. The four routine
file-read candidates were rejected as `NOT_WORTH_SAVING`. No generated content
was manually rewritten or removed to improve the treatment.

The evaluator requires this known test procedure with support from two sessions
before launching measured comparisons. The manipulation check passed. This
establishes working capture-to-review-to-briefing delivery, not task benefit.

## Preselected comparison

- Same source commit, byte fingerprint, three defect tasks, task prompts, hidden
  acceptance checks, and static note as Run 09. Source is the frozen original
  snapshot, not the newly fixed controller checkout.
- Fresh native `gpt-6.1-sol` sessions at high reasoning for every condition.
  The same context slot carries baseline, static note, or automatic memory.
- Nine runs, one per task and condition. Task order and the base condition order
  were randomized before inference; condition positions rotate within task
  blocks so every condition is first, second and third exactly once.
- Every working copy has its own clean Git repository. A discovery ceiling
  prevents native Git tooling from finding the parent checkout. This applies
  to all conditions and was validated before the experiment.
- Unchanged five-minute session limit and automated acceptance: completed agent,
  passing hidden task tests, passing original 123-test suite, passing newly added
  regression tests, and no forbidden file changes or deletions.
- Token/session limits and all relevant controller source hashes were frozen
  before review or measured inference. Raw responses and rejected candidates
  are retained. Failures are included, not silently retried or dropped.

Primary measure: uncached input plus output tokens per provisionally accepted
patch, including formation overhead. Secondary measures include execution-only
tokens, total input/output, elapsed agent time, and executed shell commands.
Reasoning tokens are already part of output and are not added twice. None of
these figures is a billed-credit or dollar estimate.

The practical continuation threshold remains at least 15% lower full primary
tokens than baseline, without an observed acceptance loss. With one attempt per
task-condition this is descriptive, not a significance test or proof of quality
equivalence. Static-note authoring and maintenance effort are unmeasured.

## Completed results

All nine patches passed hidden functional acceptance, the original 123-test
suite, and their added regression tests. Existing tests were preserved and no
forbidden file changes or deletions were detected. This is automated,
provisional acceptance; no independent human review was performed.

| Condition | Accepted | Execution tokens per accepted patch | Including formation |
| --- | ---: | ---: | ---: |
| Baseline | 3 / 3 | 28,839.7 | 28,839.7 |
| Static note | 3 / 3 | 38,942.0 | 38,942.0* |
| Automatic memory | 3 / 3 | 34,278.3 | 62,943.7 |

Tokens here mean uncached input plus output. *Static-note authoring and upkeep
were not measured. Memory formation is allocated across its three accepted
patches, including the reused onboarding described below.

Memory used **18.9% more execution tokens** than baseline and **118.3% more
including full formation**. The preselected threshold of at least 15% lower full
tokens was not met. No correctness advantage was observed under these checks.

| Task | Baseline execution tokens | Static note | Automatic memory |
| --- | ---: | ---: | ---: |
| Neutral recovery | 39,203 | 33,030 | 34,496 |
| ID-less rollout | 29,794 | 40,149 | 38,815 |
| Strict verdict set | 17,522 | 43,647 | 29,524 |

Memory was cheaper on one of three tasks. Total measured agent time was 307.8s
for baseline, 279.9s for the static note and 311.9s for memory; these are agent
times, not developer time saved. Conditions executed 24, 25 and 26 shell
commands respectively. Full input plus output, including cached input, was
518,263 / 570,714 / 533,427 tokens for task execution in the same order.

The capture correction worked, but this follow-up **does not demonstrate added
development value**. The retained fact is a test command that baseline can
readily discover. Expensive review also dominates formation. Making review
cheaper would reduce that overhead, but does not explain away the execution-only
result. Before expanding the architecture or repeating at scale, the useful
next experiment would test memories containing actual failure/recovery lessons
or otherwise unavailable decisions, with bounded, cheaper review.

## Formation accounting

- Reused onboarding: 21,522 primary tokens. These were incurred in Run 09,
  not newly billed in this follow-up, but are included for a standalone full
  formation comparison.
- Five new review sessions: 64,474 primary tokens.
- Full formation total: **85,996 primary tokens**.

Each review used a full native Codex session. Its large standard coding-agent
context is overhead of this ChatGPT-plan adapter, not a measurement of the small
API reviewer prompt alone. Four rejected candidates used 51,529 of the 64,474
review tokens. The experiment retains that actual overhead rather than replacing
it with a hypothetical cheaper API or batched-review estimate.

## Interpretation limits

The capture bug is fixed on these inputs, and the treatment now contains a real
learned procedure. The completed task comparisons showed no acceptance advantage
or token-efficiency gain in this sample. The command is also discoverable
from ordinary repository files, so this does not test retention of otherwise
unavailable historical decisions or failures.

Within-cohort comparisons share source, model, isolation and order design.
Before/after differences from Run 09 also include fresh stochastic runs, improved
Git isolation, and balanced ordering; they cannot isolate normalization alone.
Tasks are reused, selected defects in one repository, not new held-out backlog
work. Different generated patches also add different regression coverage; test
acceptance does not imply equal engineering quality. Model and cache variability
remain uncontrolled. No human-time or longitudinal maintenance claim is supported.

Review receives the normalized action and original call keys, not the full file
contents/tool results that prompted those actions. Consequently it can preserve
the observed test command but cannot infer richer lessons from repeated file
reads. This limitation is separate from the identity bug fixed for this trial.

## Artifacts and commands

- [Frozen protocol and source hashes](run-10-data/codex-manifest.json)
- [Per-run results, review outcomes and aggregate metrics](run-10-data/codex-results.json)
- [Generated source patches](run-10-data/patches/) and [grading logs](run-10-data/validation/)
- [Offline patch recheck](run-10-data/patch-recheck.json): all nine exported
  patches reapplied to fresh copies of the pinned source and passed hidden
  functional acceptance again, with zero inference calls. The original-suite
  and added-test results are recorded in the grading logs; this recheck does
  not rerun those suites.
- Full local artifacts: `.eval-local/run-10-capture-fixed/`

```powershell
bun run eval:fixed
bun scripts/export-codex-trial.ts --trial .eval-local/run-10-capture-fixed --dest experiments/run-10-data
bun scripts/verify-codex-patches.ts experiments/run-10-data
```

Completed identities are retained; rerunning the command after completion only
reports existing results. A new replication requires a new trial directory and
a frozen protocol. Original Run 09 artifacts are not rewritten.

Controller verification after completion: `bun scripts/test.ts` passed 160
tests; `py -3 -m pytest tests-run08/ -q -p no:cacheprovider` passed 14 stored-evidence
checks. Those historical checks do not independently rerun Run 08 retrieval.
