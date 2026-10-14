import { expect, test } from 'bun:test';
import { extractHermesTrajectory, type HermesMessageRow } from '../src/hermes-adapter';

// Synthetic Hermes message rows (the real source is ~/.hermes/profiles/edge/state.db).
// Shape mirrors the messages table: id (monotonic), role, content, timestamp.

const ROWS: HermesMessageRow[] = [
  { id: 1, role: 'user', content: 'build the capture lane', timestamp: 1791700000 },
  { id: 2, role: 'assistant', content: 'Starting now.', timestamp: 1791700010 },
  { id: 3, role: 'tool', content: '{"output":"ok"}', timestamp: 1791700020 },
  { id: 4, role: 'user', content: 'the tests are failing fix it', timestamp: 1791700100 },
  { id: 5, role: 'assistant', content: 'Fixed.', timestamp: 1791700110 },
  { id: 6, role: 'user', content: 'still broken look again', timestamp: 1791700200 },
  { id: 7, role: 'assistant', content: 'Found the real cause.', timestamp: 1791700210 },
  { id: 8, role: 'user', content: 'perfect all green now', timestamp: 1791700300 },
];

test('extractHermesTrajectory keeps ONLY user messages, in id order, as turns', () => {
  const t = extractHermesTrajectory(ROWS);
  expect(t.turns).toHaveLength(4);
  expect(t.turns[0]).toEqual({ index: 0, id: '1', text: 'build the capture lane' });
  expect(t.turns[1].text).toBe('the tests are failing fix it');
  expect(t.turns[2].text).toBe('still broken look again');
  expect(t.turns[3].text).toBe('perfect all green now');
});

test('assistant and tool rows never appear as turns', () => {
  const t = extractHermesTrajectory(ROWS);
  const texts = t.turns.map(x => x.text);
  expect(texts).not.toContain('Starting now.');
  expect(texts).not.toContain('{"output":"ok"}');
});

test('empty and whitespace-only user rows are skipped', () => {
  const t = extractHermesTrajectory([
    { id: 1, role: 'user', content: '', timestamp: 1 },
    { id: 2, role: 'user', content: '   ', timestamp: 2 },
    { id: 3, role: 'user', content: 'real message', timestamp: 3 },
  ]);
  expect(t.turns).toHaveLength(1);
  expect(t.turns[0].text).toBe('real message');
});

test('an all-empty row set yields an empty trajectory (no job downstream)', () => {
  const t = extractHermesTrajectory([{ id: 1, role: 'assistant', content: 'solo', timestamp: 1 }]);
  expect(t.turns).toHaveLength(0);
});

test('hermes out-of-band steering markers in user content are not excluded (they ARE the user voice)', () => {
  // Mohamed's mid-turn steering arrives as genuine user messages — unlike Codex
  // injections, these are his actual words and must survive the filter.
  const t = extractHermesTrajectory([
    { id: 1, role: 'user', content: 'wait stop use the other approach', timestamp: 1 },
  ]);
  expect(t.turns).toHaveLength(1);
});