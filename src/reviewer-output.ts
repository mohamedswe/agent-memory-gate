/**
 * Reviewer output validation — the deterministic gate between the LLM
 * reviewer and the record contract. Malformed output is rejected, never
 * repaired. The reviewer can never emit implemented/verified: those statuses
 * require real evidence pointers that this stage does not possess.
 */
import type { Candidate } from './redaction-gate';

const NODE_KINDS = ['project', 'goal', 'decision', 'attempt', 'finding', 'procedure', 'evidence'] as const;
const LIFECYCLES = ['proposed', 'agreed', 'implemented'] as const;
const EVIDENCE_STATUSES = ['tentative', 'verified', 'contested'] as const;

export interface ReviewerOutput {
  memory_kind: (typeof NODE_KINDS)[number];
  content: string;
  lifecycle: (typeof LIFECYCLES)[number];
  evidence: (typeof EVIDENCE_STATUSES)[number];
  justification: string;
}

export function validateReviewerOutput(raw: unknown, _candidate: Candidate): ReviewerOutput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('REVIEWER_OUTPUT_INVALID: not an object');
  }
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  const required = ['memory_kind', 'content', 'lifecycle', 'evidence', 'justification'];
  if (keys.some(k => !required.includes(k)) || required.some(k => !(k in o))) {
    throw new Error('REVIEWER_OUTPUT_INVALID: field set mismatch');
  }
  if (typeof o.memory_kind !== 'string' || !(NODE_KINDS as readonly string[]).includes(o.memory_kind)) {
    throw new Error('REVIEWER_OUTPUT_INVALID: memory_kind');
  }
  if (typeof o.content !== 'string' || o.content.trim().length === 0 || o.content.length > 300) {
    throw new Error('REVIEWER_OUTPUT_INVALID: content (empty or >300 chars)');
  }
  if (o.lifecycle !== 'proposed') {
    throw new Error('REVIEWER_OUTPUT_INVALID: reviewer may only emit lifecycle=proposed');
  }
  if (o.evidence !== 'tentative') {
    throw new Error('REVIEWER_OUTPUT_INVALID: reviewer may only emit evidence=tentative');
  }
  if (typeof o.justification !== 'string' || o.justification.length > 200) {
    throw new Error('REVIEWER_OUTPUT_INVALID: justification (>200 chars)');
  }
  return {
    memory_kind: o.memory_kind as ReviewerOutput['memory_kind'],
    content: o.content.trim(),
    lifecycle: 'proposed',
    evidence: 'tentative',
    justification: o.justification,
  };
}
