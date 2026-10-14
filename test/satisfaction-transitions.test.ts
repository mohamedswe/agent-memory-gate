import { expect, test } from 'bun:test';
import { detectTransitions, type TurnVerdict } from '../src/satisfaction-transitions';

const v = (index: number, state: TurnVerdict['state']): TurnVerdict => ({ index, state });

test('neutral -> pleased is a milestone transition', () => {
  const t = detectTransitions([v(0, 'neutral'), v(1, 'neutral'), v(2, 'pleased')]);
  expect(t).toHaveLength(1);
  expect(t[0].kind).toBe('milestone');
  expect(t[0].fromIndex).toBe(1);
  expect(t[0].toIndex).toBe(2);
});

test('displeased -> pleased is a recovery transition', () => {
  const t = detectTransitions([v(0, 'neutral'), v(1, 'displeased'), v(2, 'pleased')]);
  expect(t).toHaveLength(1);
  expect(t[0].kind).toBe('recovery');
  expect(t[0].fromIndex).toBe(1);
  expect(t[0].toIndex).toBe(2);
});

test('pleased -> displeased is a regression transition', () => {
  const t = detectTransitions([v(0, 'neutral'), v(1, 'pleased'), v(2, 'displeased')]);
  // milestone (0->1), regression (1->2), and unresolved (run at 2 never recovered)
  expect(t).toHaveLength(3);
  const reg = t.find(x => x.kind === 'regression');
  expect(reg).toBeDefined();
  expect(reg!.fromIndex).toBe(1);
  expect(reg!.toIndex).toBe(2);
  expect(t.find(x => x.kind === 'milestone')).toBeDefined();
  const unr = t.find(x => x.kind === 'unresolved');
  expect(unr).toBeDefined();
  expect(unr!.fromIndex).toBe(2);
});

test('same-state consecutive turns produce no transition', () => {
  expect(detectTransitions([v(0, 'neutral'), v(1, 'neutral')])).toHaveLength(0);
  expect(detectTransitions([v(0, 'pleased'), v(1, 'pleased')])).toHaveLength(0);
});

test('a pleased FIRST turn with nothing before it is not a transition', () => {
  expect(detectTransitions([v(0, 'pleased'), v(1, 'neutral')])).toHaveLength(0);
});

test('displeasure never resolved by session end is reported as an unresolved issue', () => {
  const t = detectTransitions([v(0, 'neutral'), v(1, 'displeased'), v(2, 'neutral'), v(3, 'displeased')]);
  expect(t).toHaveLength(1);
  expect(t[0].kind).toBe('unresolved');
  expect(t[0].fromIndex).toBe(1);
  expect(t[0].toIndex).toBe(3);
});

test('a recovery closes the displeased run — later displeasure is a new run', () => {
  const t = detectTransitions([v(0, 'displeased'), v(1, 'pleased'), v(2, 'displeased')]);
  expect(t).toHaveLength(3);
  expect(t.filter(x => x.kind === 'recovery')).toHaveLength(1);
  expect(t.filter(x => x.kind === 'unresolved')).toHaveLength(1);
  expect(t.find(x => x.kind === 'regression')).toBeDefined(); // pleased->displeased at 1->2
});

test('the real shape from this session: neutral run then two pleased at the end -> one milestone', () => {
  const seq = Array.from({ length: 18 }, (_, i) => v(i, 'neutral'))
    .concat([v(18, 'pleased'), v(19, 'pleased'), v(20, 'neutral'), v(21, 'neutral'), v(22, 'neutral'), v(23, 'neutral')]);
  const t = detectTransitions(seq);
  expect(t).toHaveLength(1);
  expect(t[0].kind).toBe('milestone');
  expect(t[0].toIndex).toBe(18);
});

test('empty verdicts produce nothing', () => {
  expect(detectTransitions([])).toHaveLength(0);
});