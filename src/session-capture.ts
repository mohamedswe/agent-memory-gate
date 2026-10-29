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
import { projectCommandContext } from './project-command-context';
import type { CommandContext } from './command-identity';

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
  observedKeys: {key:string;sourceKeys:string[]}[];
}

export function captureSession(sessionFilePath: string, context?: CommandContext): CaptureResult {
  const rollout = parseRollout(readFileSync(sessionFilePath, 'utf-8'));
  const ledger = new UsageLedger(context??projectCommandContext(rollout.meta.cwd??''));
  feedLedger(ledger, rollout);

  const candidates: Candidate[] = ledger.promotionCandidates().map(c => ({
    sessionFile: basename(sessionFilePath),
    projectDir: rollout.meta.cwd ?? '',
    key: c.key,
    counts: c.counts,
    ...(c.sourceKeys?{sourceKeys:c.sourceKeys}:{}),
  }));

  const redacted = redactCandidates(candidates);

  return {
    sessionFile: sessionFilePath,
    projectDir: rollout.meta.cwd ?? '',
    branch: rollout.meta.branch,
    queued: redacted.passed,
    excluded: redacted.excluded,
    unpromoted: ledger.rawKeys().filter(key=>!candidates.some(c=>c.key===key)).length,
    observedKeys: ledger.rawKeys().map(key=>({key,sourceKeys:ledger.sourceKeysFor(key)})),
  };
}
