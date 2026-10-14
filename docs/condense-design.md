# Condense pass design

Mohamed authorized continued paid calls ("I will top up", 2026-10-08).

## Goal

247 memories → ~30-40 canonical records. Near-duplicate variants merge into
one record per distinct piece of knowledge; variants are superseded (history
preserved, per design §7 — supersession is not deletion).

## Pipeline

```
records in brain
  -> [1] cluster (deterministic: command/path/keyword overlap, per project)
  -> [2] reviewer merge (one GLM call per cluster with >1 member)
  -> [3] write canonical record (kind, content, projectId, belongs_to)
  -> [4] supersede variants (supersedes edge from canonical -> each variant;
         variants' currency -> 'superseded')
  -> [5] briefing serves only 'active' records
```

## Cluster keys (deterministic, v1)

Within each project, group by extracted "core signal":
- npm scripts mentioned (`npm run typecheck`, `npm test`, ...)
- docker compose commands
- node --experimental-strip-types --test ...
- python/pytest invocations
- file paths referenced (graphify SKILL.md, query.md, ...)
- tool-polling patterns (write_stdin empty chars, wait_agent)

Two records land in the same cluster when they share a core signal. Clusters
with a single member pass through untouched.

## Reviewer merge contract

Input: the cluster's variant contents (bounded to 10 per call). Output: strict
JSON — one merged `content` (<=300 chars), `memory_kind`, `justification`.
Same validation as before: proposed/tentative only, never verified.

## Supersession semantics

- canonical record: `currency: 'active'`, new UUID, provenance points at the
  merge run + the variant record IDs it replaces
- each variant: `currency` field in frontmatter -> 'superseded' (page update,
  not deletion), plus a `supersedes` edge canonical -> variant
- briefing filters `currency === 'active'` only

## What this is NOT

- No deletion of any variant — history stays queryable
- No changes to lifecycle/evidence axes (merging doesn't promote anything)
- Single-member clusters cost nothing (no LLM call)
