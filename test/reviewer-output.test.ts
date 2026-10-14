import { expect, test } from 'bun:test';
import { validateReviewerOutput } from '../src/reviewer-output';
import type { Candidate } from '../src/redaction-gate';

// The reviewer's JSON contract: strict shape, small bounded fields, honest
// statuses. The reviewer can NEVER emit verified/implemented on its own —
// those require real evidence pointers this stage does not have.

const valid = {
  memory_kind: 'procedure',
  content: 'Verify loop for this project: npm test then npm run typecheck from the project root.',
  lifecycle: 'proposed',
  evidence: 'tentative',
  justification: 'Agent re-ran the same verify commands 7 times across sessions.',
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    sessionFile: 'rollout-synthetic.jsonl',
    projectDir: 'C:/synthetic/checkout-a',
    key: 'tool:exec:input=npm run typecheck',
    counts: { userRepeats: 0, agentRediscoveries: 7, rawMentions: 7 },
    ...overrides,
  };
}

test('valid reviewer output passes and is never verified/implemented', () => {
  const out = validateReviewerOutput(valid, candidate());
  expect(out.memory_kind).toBe('procedure');
  expect(out.lifecycle).toBe('proposed');
  expect(out.evidence).toBe('tentative');
});

test('malformed reviewer output is rejected, not repaired', () => {
  const bad = [
    { ...valid, memory_kind: 'invented_kind' },
    { ...valid, content: '' },
    { ...valid, content: 'x'.repeat(301) },
    { ...valid, lifecycle: 'implemented' },   // reviewer cannot claim this
    { ...valid, evidence: 'verified' },       // reviewer cannot claim this
    { ...valid, lifecycle: 'unknown' },
    { memory_kind: 'procedure' },             // missing fields
    'not an object',
    null,
  ];
  for (const b of bad) {
    expect(() => validateReviewerOutput(b, candidate())).toThrow();
  }
});

test('justification and content are bounded', () => {
  expect(() => validateReviewerOutput({ ...valid, justification: 'y'.repeat(201) }, candidate())).toThrow();
  const ok = validateReviewerOutput({ ...valid, justification: '' }, candidate()); // empty justification allowed
  expect(ok.justification).toBe('');
});
