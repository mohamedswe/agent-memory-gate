/**
 * Session capture — the incremental lane between Codex rollout files and the
 * capture queue. Pure and deterministic: parse one rollout, feed the usage
 * ledger, extract promotion candidates, run the redaction gate. No brain
 * writes, no network, no inference. Queue persistence and cursors belong to
 * the script layer (scripts/session-capture.ts), not here.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseRollout, feedLedger } from './rollout-reader';
import { UsageLedger } from './usage-ledger';
import { redactCandidates, type Candidate, type ExcludedCandidate } from './redaction-gate';

export interface CaptureResult {
  sessionFile: string;
  projectDir: string;
  branch: string | null;
  /** Redaction-passed candidates ready to queue for review. */
  queued: Candidate[];
  /** Secret-shaped candidates excluded whole, each with its reason. */
  excluded: ExcludedCandidate[];
  /** Candidates the ledger found but were not promoted (below threshold / flow). */
  unpromoted: number;
}

export function captureSession(sessionFilePath: string): CaptureResult {
  const rollout = parseRollout(readFileSync(sessionFilePath, 'utf-8'));
  const ledger = new UsageLedger();
  feedLedger(ledger, rollout);

  const candidates: Candidate[] = ledger.promotionCandidates().map(c => ({
    sessionFile: basename(sessionFilePath),
    projectDir: rollout.meta.cwd ?? '',
    key: c.key,
    counts: c.counts,
  }));

  const redacted = redactCandidates(candidates);

  return {
    sessionFile: sessionFilePath,
    projectDir: rollout.meta.cwd ?? '',
    branch: rollout.meta.branch,
    queued: redacted.passed,
    excluded: redacted.excluded,
    unpromoted: 0, // below-threshold keys are internal ledger state; promotionCandidates() is the full candidate set
  };
}