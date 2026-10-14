import { expect, test } from 'bun:test';
import { parseRollout, feedLedger } from '../src/rollout-reader';
import { UsageLedger } from '../src/usage-ledger';

// Synthetic fixture — matches the observed Codex rollout JSONL schema shapes
// (session_meta / response_item / event_msg / turn_context wrappers), with
// planted, known content so expected counts are auditable. No real session
// text is used anywhere in this file.

const SYNTHETIC_ROLLOUT = [
  JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session-1', cwd: 'C:/synthetic/checkout-a', git: { branch: 'main' }, timestamp: '2026-10-07T01:00:00.000Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-1', content: [{ type: 'input_text', text: 'we use bun, not npm' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-2', content: [{ type: 'input_text', text: 'We use Bun, not npm!' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'm-3', content: [{ type: 'output_text', text: 'Running the test suite now.' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'run_tests', arguments: '{"path":"test/"}', call_id: 'call-1', id: 'fc-1' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', id: 'fco-1', output: '13 pass' } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { id: 'fc-1' }, turn_id: 't-1' } }),
  JSON.stringify({ type: 'turn_context', payload: { cwd: 'C:/synthetic/checkout-a', turn_id: 't-1' } }),
].join('\n');

test('parses a synthetic rollout into typed events, ignoring wrapper duplicates', () => {
  const rollout = parseRollout(SYNTHETIC_ROLLOUT);

  expect(rollout.meta.cwd).toBe('C:/synthetic/checkout-a');
  expect(rollout.meta.branch).toBe('main');

  expect(rollout.events).toHaveLength(5);
  const [user1, user2, assistant, toolCall, toolOutput] = rollout.events;
  expect(user1).toEqual({ kind: 'user_message', id: 'm-1', text: 'we use bun, not npm' });
  expect(user2).toEqual({ kind: 'user_message', id: 'm-2', text: 'We use Bun, not npm!' });
  expect(assistant).toEqual({ kind: 'assistant_message', id: 'm-3', text: 'Running the test suite now.' });
  expect(toolCall).toEqual({ kind: 'tool_call', id: 'fc-1', callId: 'call-1', name: 'run_tests', args: { path: 'test/' } });
  expect(toolOutput).toEqual({ kind: 'tool_output', id: 'fco-1', callId: 'call-1', text: '13 pass' });
});

test('feeding the ledger from a parsed rollout produces the expected candidates', () => {
  const ledger = new UsageLedger();
  feedLedger(ledger, parseRollout(SYNTHETIC_ROLLOUT));

  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(1); // the repeated bun statement; single tool call does not promote
  expect(candidates[0].key).toBe('we use bun not npm');
  expect(candidates[0].counts.userRepeats).toBe(2);
});

test('a partial trailing line is skipped without error', () => {
  const truncated = SYNTHETIC_ROLLOUT + '\n{"type":"response_item","payload":{"type":"me';
  const rollout = parseRollout(truncated);
  expect(rollout.events).toHaveLength(5);
});

test('duplicated response_item lines are deduplicated by id', () => {
  const duplicate = SYNTHETIC_ROLLOUT + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-1', content: [{ type: 'input_text', text: 'we use bun, not npm' }] } });
  const ledger = new UsageLedger();
  feedLedger(ledger, parseRollout(duplicate));
  expect(ledger.countsFor('we use bun not npm')!.userRepeats).toBe(2); // not 3
});
