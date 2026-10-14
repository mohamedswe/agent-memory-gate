# Incremental delivery and gates

This is a working breakdown of the approved direction, not a claim that the system is implemented.

## 1. Record ownership foundation (current increment)

- Use actual G-brain PGLite in isolated tests, no live paths.
- Canonical records reside in G-brain pages, separate engine per owner.
- Test immutable identity, private defaults, foreign-write denial, eligible shared read, safe shared projection, source provenance, and separate status axes.
- Validate the contract at runtime; require evidence pointers/verification timestamp for a verified label without claiming that pointer existence proves the claim.
- Prove each new behavior RED before GREEN. Preserve output.
- Review spec compliance first, then independent code quality; parent reruns tests.

## 2. Graph and durable identity

Tests first: declare vocabulary in disposable schema pack; reject invalid node/edge combinations; stable project identity across aliases/moves; preserve distinct checkout contexts; references preserve owner and target identity. Evidence links point to relocatable source events. Source identity and brain identity remain separate axes.

## 3. Corrections and history

Tests first: scoped explicit correction supersedes old guidance without deleting it; historical reads retain rationale; tentative/newer claim cannot replace verified guidance merely due to timestamp. Atomic/idempotent updates survive interruption. Verify restart durability against temporary on-disk brains in one owning process.

## 4. Incremental capture and privacy

Tests first against synthetic source fixtures matching inspected schemas: Hermes tool call/result IDs; Codex JSONL variants, partial trailing writes and duplicate wrappers; cursor resume and mutation/truncation detection; agent/reviewer dedupe; no advancement after partial failure. Secret-source exclusion precedes any inference. Untrusted source text cannot change access or instructions. Define sensitive-cloud handling before processing personal material.

## 5. Shared budget before reviewer

Atomic reservations shared by both owners; conservative fresh prices; bounded input/output/reasoning; reservation kept on ambiguous timeout; every retry obtains a reservation; reconcile actual cost. Missing accounting/pricing pauses review while retrieval continues. User decision required for month boundary policy. No paid test or automatic job without explicit authorization.

## 6. Authenticated service and pilot

Resolve transport grants and PGLite single-owner process lifecycle. Test denied writes and private traversal with genuinely authenticated clients, including omitted/error metadata, caches and logs. Pick a pilot project with Mohamed. Capture evidence and retrieve in a genuinely fresh Codex session; then Hermes integration, with no changes to existing cached system prompt mid-session.

## 7. Bounded retrieval and read-only explorer

Test meaningful traversal, contradiction inclusion, permission-safe views, full serialized token allowance and disclosed omissions. Run week-long observation before expanding: recall quality, repeated steering, false promotions, duplicates, cost and backlog age.

## Explicitly deferred decisions

Scheduler/host, transport credentials, idle threshold, batch allowance, context budget, budget reset boundary, embedding costs, sensitive-data handling, retention/forgetting, pilot project, history backfill and viewer placement. These do not block the isolated foundation, but cannot be silently chosen during deployment.
