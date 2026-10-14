import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CrossSessionLedger } from '../src/cross-session-ledger';

function makeLedger(): { l: CrossSessionLedger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xsession-'));
  return { l: new CrossSessionLedger(join(dir, 'ledger.json')), dir };
}

const P = 'C:/synthetic/emara';
const KEY = 'npm run dev -- --host';

test('a key seen once in each of two DIFFERENT sessions (same project) crosses the threshold', () => {
  const { l, dir } = makeLedger();
  l.observe(P, KEY, 'rollout-a.jsonl');
  expect(l.newlyCrossing(P)).toEqual([]);          // one session: not yet
  l.observe(P, KEY, 'rollout-b.jsonl');
  expect(l.newlyCrossing(P)).toEqual([KEY]);       // two distinct sessions: crosses
  rmSync(dir, { recursive: true });
});

test('the same session observed twice does NOT double count (idempotent session sets)', () => {
  const { l, dir } = makeLedger();
  l.observe(P, KEY, 'rollout-a.jsonl');
  l.observe(P, KEY, 'rollout-a.jsonl');            // regrown session re-captured
  expect(l.newlyCrossing(P)).toEqual([]);           // still one distinct session
  rmSync(dir, { recursive: true });
});

test('counts are scoped per project — the same key in another project does not bleed', () => {
  const { l, dir } = makeLedger();
  l.observe(P, KEY, 'rollout-a.jsonl');
  l.observe('C:/synthetic/insectflux', KEY, 'rollout-b.jsonl');
  expect(l.newlyCrossing(P)).toEqual([]);           // emara still has 1 session
  expect(l.newlyCrossing('C:/synthetic/insectflux')).toEqual([]);
  rmSync(dir, { recursive: true });
});

test('markPromoted prevents re-queuing forever', () => {
  const { l, dir } = makeLedger();
  l.observe(P, KEY, 'rollout-a.jsonl');
  l.observe(P, KEY, 'rollout-b.jsonl');
  expect(l.newlyCrossing(P)).toEqual([KEY]);
  l.markPromoted(P, KEY);
  l.observe(P, KEY, 'rollout-c.jsonl');            // it keeps appearing every session
  expect(l.newlyCrossing(P)).toEqual([]);           // but is never re-queued
  rmSync(dir, { recursive: true });
});

test('ledger state survives reload (durable)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xsession-'));
  const path = join(dir, 'ledger.json');
  const l1 = new CrossSessionLedger(path);
  l1.observe(P, KEY, 'rollout-a.jsonl');
  l1.markPromoted(P, 'some-other-key');
  const l2 = new CrossSessionLedger(path);
  l2.observe(P, KEY, 'rollout-b.jsonl');
  expect(l2.newlyCrossing(P)).toEqual([KEY]);        // a's session count survived
  expect(l2.isPromoted(P, 'some-other-key')).toBe(true);
  rmSync(dir, { recursive: true });
});

test('sessionCount reports the distinct-session count for provenance', () => {
  const { l, dir } = makeLedger();
  l.observe(P, KEY, 'rollout-a.jsonl');
  l.observe(P, KEY, 'rollout-b.jsonl');
  l.observe(P, KEY, 'rollout-c.jsonl');
  expect(l.sessionCount(P, KEY)).toBe(3);
  rmSync(dir, { recursive: true });
});

test('a corrupt ledger file falls back to fresh (fail-open to re-observe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xsession-'));
  const path = join(dir, 'ledger.json');
  const { writeFileSync } = require('node:fs');
  writeFileSync(path, '{corrupt json', 'utf-8');
  const l = new CrossSessionLedger(path);
  l.observe(P, KEY, 'rollout-a.jsonl');
  expect(l.sessionCount(P, KEY)).toBe(1);           // fresh, not crashed
  rmSync(dir, { recursive: true });
});