import { expect, test } from 'bun:test';
import { UsageLedger } from '../src/usage-ledger';

// Slice 7 — structured tool args must serialize stably, not as "[object Object]".
// Real-session probing showed nested args (questions: [{...}]) collapsing into
// identical "[object Object]" keys, creating false rediscovery candidates.

test('nested tool args serialize to distinct, stable keys', () => {
  const ledger = new UsageLedger();
  ledger.recordToolCall('request_user_input_async', { questions: [{ id: 'q1', text: 'which repo?' }] });
  ledger.recordToolCall('request_user_input_async', { questions: [{ id: 'q2', text: 'which branch?' }] });
  // Same question repeated = genuine rediscovery:
  ledger.recordToolCall('request_user_input_async', { questions: [{ id: 'q1', text: 'which repo?' }] });

  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(1);
  expect(candidates[0].key).toContain('q1');
  expect(candidates[0].key).not.toContain('[object Object]');
  expect(candidates[0].counts.agentRediscoveries).toBe(2);
});

test('key order in nested args does not create false distinct keys', () => {
  const ledger = new UsageLedger();
  ledger.recordToolCall('ask', { a: { x: 1, y: 2 } });
  ledger.recordToolCall('ask', { a: { y: 2, x: 1 } });

  const counts = ledger.countsFor(
    JSON.parse(JSON.stringify({})) === null ? '' : 'tool:ask:a={"x":1,"y":2}' // placeholder, see assertion below
  );
  // Both orderings hit ONE key with rediscoveries=2 (promotion):
  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(1);
  expect(candidates[0].counts.agentRediscoveries).toBe(2);
});
