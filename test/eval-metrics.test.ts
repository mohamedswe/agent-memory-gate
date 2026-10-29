import { expect, test } from 'bun:test';
import { parseEvalMetrics } from '../src/eval-metrics';
const lines = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');
const usage = (input: number, output: number, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached });
const turn = (input: number, output: number, id?: string) => ({ type: 'token_usage_record', payload: { request_id: id, usage: usage(input, output) } });
const cum = (input: number, output: number, cached = 0) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(input, output, cached) } } });
test('per-turn counts sum, including equal counts from distinct requests', () => {
  const r = parseEvalMetrics(lines(turn(100, 10, 'a'), turn(100, 10, 'b'), turn(200, 20, 'c')));
  expect(r.accounting).toBe('per-turn'); expect(r.usage?.input).toBe(400); expect(r.usage?.total).toBe(440);
});
test('cumulative observations replace per-turn observations without double counting', () => {
  expect(parseEvalMetrics(lines(turn(100, 10), cum(100, 10), cum(300, 30, 80), cum(300, 30, 80))).usage)
    .toEqual({ input: 300, cached: 80, uncached: 220, output: 30, reasoning: null, total: 330 });
});
test('explicit ids deduplicate wrappers; unidentified equal turns remain distinct', () => {
  expect(parseEvalMetrics(lines(turn(20, 2, 'a'), turn(20, 2, 'a'))).usage?.input).toBe(20);
  expect(parseEvalMetrics(lines(turn(20, 2), turn(20, 2))).usage?.input).toBe(40);
});
test('missing usage stays null rather than zero', () => {
  expect(parseEvalMetrics(lines({ type: 'message' })).usage).toBeNull(); expect(parseEvalMetrics('').accounting).toBe('missing');
});
test('invalid or regressing counters invalidate accounting', () => {
  expect(parseEvalMetrics(lines(cum(10, 2, 11))).accounting).toBe('invalid');
  expect(parseEvalMetrics(lines(cum(100, 20), cum(50, 10))).usage).toBeNull();
});
test('resume keeps session total; distinct sessions sum', () => {
  const meta = (id: string) => ({ type: 'session_meta', payload: { id } });
  expect(parseEvalMetrics(lines(meta('a'), cum(100, 10), meta('a'), cum(200, 20), meta('b'), cum(50, 5))).usage?.input).toBe(250);
});
test('exec JSON usage works and reasoning is not added twice', () => {
  const r = parseEvalMetrics(lines({ type: 'turn.completed', usage: { ...usage(100, 20, 40), output_tokens_details: { reasoning_tokens: 15 } } }));
  expect(r.usage?.total).toBe(120); expect(r.usage?.reasoning).toBe(15);
});
test('tool ids deduplicate wrappers and JSON command arguments parse', () => {
  const call = { type: 'response_item', payload: { type: 'function_call', call_id: 'x', name: 'exec_command', arguments: JSON.stringify({ cmd: 'bun test "a b.ts"' }) } };
  const r = parseEvalMetrics(lines(call, call, { type: 'item.started', item: { type: 'command_execution', id: 'y', command: 'bun test' } }, { type: 'item.completed', item: { type: 'command_execution', id: 'y', command: 'bun test' } }));
  expect(r.toolCalls).toBe(2); expect(r.commands).toEqual(['bun test "a b.ts"', 'bun test']);
});
test('timestamps give log span, not human time; partial writes reported', () => {
  const r = parseEvalMetrics(lines({ timestamp: '2026-10-27T12:00:05Z' }, { timestamp: '2026-10-27T12:00:01Z' }) + '\n{"unfinished"');
  expect(r.elapsedSeconds).toBe(4); expect(r.malformedLines).toBe(1);
});
