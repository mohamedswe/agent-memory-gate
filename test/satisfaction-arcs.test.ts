import { expect, test } from 'bun:test';
import { detectArcs, type TurnVerdict } from '../src/satisfaction-arcs';

const v = (index: number, state: TurnVerdict['state']): TurnVerdict => ({ index, state });

test('a displeased -> pleased sequence is a resolved arc spanning those turns', () => {
  const arcs = detectArcs([v(0, 'neutral'), v(1, 'displeased'), v(2, 'displeased'), v(3, 'pleased')]);
  expect(arcs).toHaveLength(1);
  expect(arcs[0].kind).toBe('resolved');
  expect(arcs[0].fromIndex).toBe(1);
  expect(arcs[0].toIndex).toBe(3);
});

test('displeasure that never resolves is an unresolved arc to the last turn', () => {
  const arcs = detectArcs([v(0, 'neutral'), v(1, 'displeased'), v(2, 'neutral'), v(3, 'displeased')]);
  expect(arcs).toHaveLength(1);
  expect(arcs[0].kind).toBe('unresolved');
  expect(arcs[0].fromIndex).toBe(1);
  expect(arcs[0].toIndex).toBe(3);
});

test('pleased with no prior displeasure is not an arc (routine success)', () => {
  const arcs = detectArcs([v(0, 'neutral'), v(1, 'pleased')]);
  expect(arcs).toHaveLength(0);
});

test('a second displeased after a resolved arc starts a NEW arc', () => {
  const arcs = detectArcs([v(0, 'displeased'), v(1, 'pleased'), v(2, 'displeased'), v(3, 'pleased')]);
  expect(arcs).toHaveLength(2);
  expect(arcs[0].kind).toBe('resolved');
  expect(arcs[0].fromIndex).toBe(0);
  expect(arcs[0].toIndex).toBe(1);
  expect(arcs[1].kind).toBe('resolved');
  expect(arcs[1].fromIndex).toBe(2);
  expect(arcs[1].toIndex).toBe(3);
});

test('all-neutral sessions produce no arcs', () => {
  expect(detectArcs([v(0, 'neutral'), v(1, 'neutral')])).toHaveLength(0);
});

test('pleased turns INSIDE an arc do not close it — only a pleased AFTER displeasure resolves', () => {
  // pleased at 0 (before any displeasure) must not resolve a later arc
  const arcs = detectArcs([v(0, 'pleased'), v(1, 'displeased'), v(2, 'pleased')]);
  expect(arcs).toHaveLength(1);
  expect(arcs[0].kind).toBe('resolved');
  expect(arcs[0].fromIndex).toBe(1);
  expect(arcs[0].toIndex).toBe(2);
});

test('empty verdict list produces no arcs', () => {
  expect(detectArcs([])).toHaveLength(0);
});