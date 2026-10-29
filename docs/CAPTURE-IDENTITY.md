# Capture identity fix

The Run 09 onboarding sessions performed repeated work but produced no memories.
The old gate compared full tool-call strings. The production capture path now
recognizes a small, explicit set of action identities while retaining every
original call as provenance.

## Supported matching

- `bun run test` matches `bun scripts/test.ts` when the supplied project
  `package.json` declares exactly that simple Bun script target and has no
  `pretest` or `posttest` hooks. Other simple Bun script aliases work the same way.
- Plain `Get-Content`, `Get-Content -Path`, and `Get-Content -LiteralPath` match
  for a concrete path without wildcard or interpolation syntax.
- Simple batched reads produce one observation per file. Repeating a file
  inside one batched call never manufactures two promotion observations.
- Native Codex PowerShell `-Command` wrappers are recognized. Wrappers with
  startup options that can change environment are left intact.
- Shell timing/output limits do not change supported action identities.
  Different working directories, flags, explicit environments, pipelines,
  redirections, conditionals, hooks, content modes and unknown syntax retain
  their original exact identities. Unknown quoted whitespace is preserved.

This is a conservative action extractor, not a general shell interpreter.
Mixed batches containing unsupported statements are not split. Arbitrary
JavaScript orchestration and unknown shell dialects are not interpreted.

## Source and state behavior

`UsageLedger` accepts an explicit package snapshot. Live capture reads the
current checkout's `package.json` at capture time; historical replays must
supply the appropriate pinned snapshot. The system cannot reconstruct earlier
uncommitted script definitions from a command string. Missing or unreadable
package data disables alias expansion rather than guessing a script target.

The same action identity feeds within-session and cross-session promotion.
Original call keys and distinct source-session identities survive queueing,
review input and durable record evidence pointers. The redaction gate checks
both normalized identities and original calls, so normalization cannot hide
secret-shaped input. Relative credential paths are also excluded.

Rollout events without item IDs no longer all collapse into one empty-string
identity. Calls and their outputs deduplicate separately by call ID; unidentified
messages remain distinct. Repeated system-injected messages are excluded from
promotion as well as cross-session observations.

Existing ledger state and cursors remain readable. Old processed sessions are
not silently replayed, and previously promoted keys are not rewritten. New
normalized identities are versioned separately from exact legacy tool keys.
Backfill should use an explicitly selected source and a separate queue/state
directory. Capture makes no inference calls and writes no live memory records.

Dry-run capture simulates observations and promotions in memory without writing
queue, ledger or cursor state. Real capture queues the same promotions once.

## Verification against the actual failed sessions

```powershell
bun scripts/replay-run09-capture.ts
```

The offline replay uses the two original Run 09 onboarding rollouts and their
pinned package manifest. A local project overlay supplies only that manifest;
the tool calls and messages remain unchanged. It invokes the actual capture
CLI rather than an alternate normalization approximation.

Result: **five repeated-action candidates**, including one canonical test-command
candidate corroborated by the project manifest and two source sessions. All
retain their original calls. A second capture adds no duplicate queue entries.
The original nine-run result artifact's hash stays unchanged. No inference runs
or live-memory writes are performed.

See [capture-fix replay evidence](../experiments/run-09-data/capture-fix-replay.json).
Candidates still require review; four repeated file reads are not automatically
useful lessons. This verification establishes corrected capture, not a new
development-productivity result.

The native evaluator now refuses a new learned-memory comparison if capture
produces no candidates or reviewed guidance fails to retain the known test
procedure with support from two sessions. Completed Run 09 results remain
readable and are never rerun under the same identities.
