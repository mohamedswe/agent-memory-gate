# Memory tree: does grouping by meaning find what repetition misses?

Written 2026-10-30, before the tree was run on real logs with a neural embedder.

## Question

The correction census (Runs of 2026-10-29) found that the user repeats the same
preferences across sessions and agents, but almost never in the same words:
exact signatures and word overlap each found 2 repeats in 68 corrections. A hand
reading found about 8 recurring themes. Can a meaning-based tree (MemTree-style
insertion, no LLM) recover those themes, so that "repeated across sessions" can be
measured on meaning instead of wording?

## Setup

- Input: corrections from the census detector (v2) plus directive-shaped clauses
  from other user turns, from Codex, Claude Code and Hermes logs.
- Tree: insert in time order; route to the most similar child if it clears a
  threshold that rises with depth, else start a new child. Nodes are centroids,
  labels are medoids (real messages). No model call anywhere.
- Embedders: `tfidf` (hashed word + character-trigram TF-IDF, lexical control) and
  `all-MiniLM-L6-v2` (local, via transformers.js or Python).
- Labels: [`labels-v1.json`](labels-v1.json), 32 corrections in 10 themes, assigned
  by one annotator (Claude) on 2026-10-29 before the tree existed. Items are
  identified by session id and a text hash; no message text is stored.
- Default thresholds were set before evaluation (`DEFAULT_TREE` in
  `src/memory-tree.ts`). The sweep is reported in full; picking the best sweep row
  would be tuning on the test set.

## Criteria, fixed before the MiniLM run

At the default threshold, read at depth 1, MiniLM counts as finding the missing
signal if all hold:

1. it recovers at least 5 of the 7 cross-session themes;
2. pairwise precision is at least 0.5;
3. pairwise recall beats word overlap by at least 0.2.

Expected failure: `misread-intent` groups corrections by intent ("no, I meant X"),
not topic, so similarity should not recover it. It stays in the scores.

## Already observed (lexical control only)

Replaying the 68 corrections from the sample file with `tfidf` at the default
threshold (0.30): precision 0.64, recall 0.16, F1 0.25. It recovered
`run-tests-in-docker` (3 corrections, 3 sessions), which word overlap missed,
plus the exact-duplicate `ask-what-is-unclear`. Word overlap: precision 1.00,
recall 0.04.

## Limits

One user, one annotator, 32 labelled items, 45 gold pairs. This tests whether
the grouping works at all on this user's data, not whether it generalizes.

## Run

```sh
bun scripts/memory-tree.ts                      # tfidf control
bun add @huggingface/transformers               # once
bun scripts/memory-tree.ts --embedder minilm    # or: pip install sentence-transformers; --embedder python
```

Outputs go to `live-run/` (git-ignored; `memory-tree.json` contains message text).
