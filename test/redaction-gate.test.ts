import { expect, test } from 'bun:test';
import { redactCandidates, Candidate } from '../src/redaction-gate';

// Synthetic candidates shaped like the real export (never copied text).
function candidate(key: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    sessionFile: 'rollout-synthetic.jsonl',
    projectDir: 'C:/synthetic/checkout-a',
    key,
    counts: { userRepeats: 0, agentRediscoveries: 3, rawMentions: 3 },
    ...overrides,
  };
}

test('secret-shaped candidates are excluded, clean ones pass through', () => {
  const input = [
    candidate('tool:exec:input=npm run typecheck'),
    candidate('tool:exec:input=export API_KEY=sk-abcdefghijklmnop1234'),
    candidate('tool:exec:input=git push ghp_abcdefghijklmnopqrst123456'),
    candidate('tool:exec:input=aws configure AKIAIOSFODNN7EXAMPLE'),
    candidate('user statement about deployment'),
    candidate('tool:exec:input=psql password=hunter2'),
  ];

  const result = redactCandidates(input);

  expect(result.passed).toHaveLength(2);
  expect(result.passed[0].key).toBe('tool:exec:input=npm run typecheck');
  expect(result.passed[1].key).toBe('user statement about deployment');
  expect(result.excluded).toHaveLength(4);
  // Fail-closed exclusions are listed, never silently dropped:
  expect(result.excluded.every(e => e.reason.length > 0)).toBe(true);
});

test('wait-call candidates are excluded by default category filter', () => {
  const input = [
    candidate('tool:wait:cell_id=45:max_tokens=3000:yield_time_ms=10000'),
    candidate('tool:exec:input=npm test'),
  ];
  const result = redactCandidates(input);
  expect(result.passed).toHaveLength(1);
  expect(result.passed[0].key).toBe('tool:exec:input=npm test');
  expect(result.excluded[0].reason).toContain('category');
});

test('wait-calls pass when category filter is disabled', () => {
  const input = [candidate('tool:wait:cell_id=45:max_tokens=3000')];
  const result = redactCandidates(input, { includeWaitCalls: true });
  expect(result.passed).toHaveLength(1);
  expect(result.excluded).toHaveLength(0);
});
