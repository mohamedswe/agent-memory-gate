# Proving added value in everyday development

Prepared 2026-10-27. Implementation and local experiment controls are complete;
comparative runs use the explicitly authorized ChatGPT/Codex plan. The native
protocol amendment replaces dollar cost with disclosed token proxies because
plan sessions do not report per-run charges. No live-memory changes have been
made. See [Run 09 status](../experiments/run-09-methodology-baseline.md).

## Decision to make

Does automatically learned project memory improve accepted development work
enough to justify its inference, context, maintenance, and correction costs,
compared with the same coding agent using ordinary repository instructions?

Separate three questions: is stored knowledge accurate, does it change useful
behavior, and is the resulting benefit larger than its operating overhead?

## Audit of the existing evidence

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| 123 passing core tests, rerun October 27 | Tested implementation contracts work in this environment | Accurate memories or developer productivity |
| Run 08 evidence tests | Arithmetic, stored result consistency, and selected documentation figures | A fresh reproduction of ingestion or retrieval; the dual-brain recall test counts stored boolean verdicts |
| Runs 01-04 | Preliminary paired observations of efficiency and compliance | Broad generalization, reliable speed improvement, or superiority to maintained project instructions |
| Run 07 | The capture-to-consumption loop can operate on realistic work | A causal 29% memory benefit: the baseline and memory agents performed different tasks |
| Run 08 | A small cost/coverage demonstration with explicit limitations | Equal-history, end-to-end comparative cost: fresh A-MEM ingestion is compared with existing dual-brain memory whose earlier review cost is outside the ingestion figure |
| Run 04 | The memory agents avoided the tested stale guidance | General resistance to stale memory or adversarial injection; the six sessions include three baseline sessions |

The October 14 transition-review implementation postdates the October 12
Run 08 experiment. The current satisfaction lane needs its own evaluation.
The public export includes result JSONs, but not the original Run 08 execution
scripts or the private raw transcripts for the paired development runs.

Measurement concern reproduced October 27: `scripts/eval-score.ts` reports
zero usage for two synthetic `token_usage_record` events carrying usage in
`payload.usage`. `scripts/eval-collect.ts` recognizes that shape but takes a
maximum of per-turn counts instead of summing them when cumulative counts are
absent. This does not establish that the published sessions used the affected
format. Audit their original logs before revising their totals. Validate
command extraction, resumed sessions, timing, and wrapper deduplication too.

## Step 1: establish trustworthy measurement

- Pin the agent model, settings, tools, memory implementation, dependencies,
  repository commits, and prompts. Save a manifest and artifact hashes.
- Validate usage extraction against known cumulative, per-turn, duplicate,
  partial, and resumed-session fixtures; cross-check provider usage where
  available. Missing accounting is an explicit invalid measurement, not zero.
- Record cached input, uncached input, output, paid memory processing, and
  actual billed usage separately. Do not double-count reasoning when it is
  already included in output usage.
- Record active human time separately from agent elapsed time and idle time.
- Save patches, test output, source-memory evidence, and blinded review
  decisions. Test success alone does not establish task acceptance.

## Step 2: a small controlled development trial

Select 12 genuine backlog tasks across two repositories before inspecting
which ones memory helps. Include feature work, debugging, maintenance, and
resuming previous work. Include tasks with little expected memory benefit.
Record exclusions and their reasons. This is a feasibility sample, not a
statistically powered study; use its variance to size a follow-up.

Run each task from identical clean snapshots in three fresh-agent conditions:

| Condition | Available context |
| --- | --- |
| A: normal development | Existing README, AGENTS.md, source, tests, and normal tools |
| B: maintained instructions | A plus concise human-maintained project guidance, wired to load at startup |
| C: automatic memory | A plus automatically generated BRIEFING.md and HISTORY.md, wired identically |

This first pass requires 36 agent runs. Budget and execution are a separate
decision; no runs are launched by this document.

For B and C, use only evidence available before the target task. Record human
authoring and upkeep time for B and full capture/review/correction costs for C.
Freeze context before each comparison. Never place the target solution,
acceptance rubric, later-session knowledge, or another condition's output into
memory. Keep ordinary repository instructions available to every condition.
Audit global agent memory and external tools for contamination.

Randomize execution order, use identical tool and resource limits, and isolate
workspaces and writable state. Have a reviewer score anonymized patches using
acceptance criteria fixed before execution, with regression checks. Repeated
runs estimate agent variability; they are not independent new development tasks.

## Step 3: check everyday usefulness prospectively

After the controlled trial, observe at least two weeks of ordinary work on
the same projects. Fix task eligibility before knowing condition outcomes;
assign conditions before starting each session, balanced within project and
task category. Capture prior-session evidence consistently, while exposing
only the assigned context. Evaluate new memory using later sessions.

Record every eligible task, including abandoned and failed tasks. Log user
corrections, interventions, accepted changes, memory maintenance, and harmful
advice. Do not count an unexecuted hypothetical mistake as an avoided failure.
Use examples to explain measured effects, not as a substitute for controls.

Human learning and shared repository evolution create carryover in a small
within-developer trial. Treat this phase as an adoption and operational check;
the isolated controlled comparisons provide the stronger causal evidence.
Extend observation if there are too few opportunities to reuse prior knowledge.

## Scorecard and decision rule

Report every condition's task acceptance rate, failures, human minutes,
elapsed time, total operating cost, correction count, and memory-caused errors.
Include setup and maintenance overhead and report both initial and amortized
costs with the amortization window stated. Never discard failed runs when
calculating cost per accepted task. Report per-task effects and uncertainty;
group repeated observations by task and project.

Audit memory accuracy separately against source evidence: supported, obsolete,
contradicted, irrelevant, and unsupported. Judge completeness using important
lessons identified independently from source sessions, not only the memories
the system chose to save. Measure whether a retrieved memory changed an action
and whether that action helped the accepted result.

Proposed practical threshold, to fix before execution: at least 15% lower
total cost per accepted task or 15% lower active human time than A, with no
observed drop in task acceptance or material memory-caused regression.
Choose one as the primary endpoint before running; the other is secondary.
A small trial cannot certify non-inferior quality, even if it observes no drop.
Treat inconclusive uncertainty as a reason to gather more evidence.

For C versus B, require a measurable advantage in upkeep time, repeated user
corrections, or the chosen primary endpoint, with comparable acceptance and
no offsetting operating burden. Improvement over A alone does not show that
automatic memory earns its complexity over well-maintained instructions.

- Useful on resumption/debugging only: narrow the target use case and test it
  prospectively on new tasks.
- Matches B but needs less maintenance: position as automatic upkeep of
  project guidance.
- Saves input tokens but increases total cost or human effort: do not claim
  a productivity win.
- No reproducible benefit, or harmful guidance offsets savings: simplify or
  stop the approach rather than expand features.

## Reporting discipline

Distinguish arithmetic verification, experimental validity, and real-world
generalization. Label existing numbers as exploratory. Do not use "zero-cost
memory" for a full system with paid review and briefing-consumption costs.
State that Run 07 observed a 29% difference across different tasks; do not
attribute all of it to memory. Scope the stale-advice result to its tested cases.

Methodology context: [METR's February 2026 design update](https://metr.org/blog/2026-02-24-uplift-update/)
describes task-selection and time-measurement problems in developer productivity
experiments. Use it to motivate prospective eligibility rules and careful time
accounting, not as evidence about this project's effect.
