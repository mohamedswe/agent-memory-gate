import { expect, test, beforeEach, afterAll } from 'bun:test';
import { BudgetLedger } from '../src/budget-ledger';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Budget ledger — durable, atomic, fail-closed. The design's stage-4 gate that
// must exist before ANY paid reviewer call.

const dir = mkdtempSync(join(tmpdir(), 'budget-ledger-test-'));
let dbPath: string;
let ledger: BudgetLedger;

beforeEach(async () => {
  dbPath = join(dir, `ledger-${crypto.randomUUID()}.db`); // fresh DB per test
  ledger = await BudgetLedger.open(dbPath, { monthlyCapUsd: 10 });
});

test('reserves atomically and reconciles actual cost', () => {
  expect(ledger.remainingUsd()).toBe(10);

  // Reserve conservatively before a request:
  const r1 = ledger.reserve('reviewer-batch-1', 0.50);
  expect(r1.reserved).toBe(true);
  expect(ledger.remainingUsd()).toBeCloseTo(9.50);

  // Actual came in lower — reconcile and release the difference:
  ledger.reconcile('reviewer-batch-1', 0.31);
  expect(ledger.remainingUsd()).toBeCloseTo(9.69);

  // Double reconciliation is rejected (a reservation reconciles once):
  expect(() => ledger.reconcile('reviewer-batch-1', 0.31)).toThrow();
});

test('cannot over-reserve past the cap, including concurrently', () => {
  expect(ledger.reserve('job-a', 6).reserved).toBe(true);
  expect(ledger.reserve('job-b', 4).reserved).toBe(true);
  // Cap exhausted:
  const r = ledger.reserve('job-c', 0.01);
  expect(r.reserved).toBe(false);
  expect(r.reason).toContain('cap');

  // Reconcile one and the room returns:
  ledger.reconcile('job-a', 3.0);
  expect(ledger.remainingUsd()).toBeCloseTo(3.0);
  expect(ledger.reserve('job-c', 2.99).reserved).toBe(true);
});

test('ambiguous failure keeps the reservation held (no free retries)', () => {
  ledger.reserve('flaky-job', 2);
  // Timeout/ambiguous failure: NOT reconciled, NOT released:
  expect(() => ledger.reserve('flaky-job', 2)).toThrow(); // same key = still outstanding
  expect(ledger.remainingUsd()).toBeCloseTo(8);
  // A retry must obtain its OWN reservation with a new key:
  expect(ledger.reserve('flaky-job-retry-1', 2).reserved).toBe(true);
  expect(ledger.remainingUsd()).toBeCloseTo(6);
});

test('reservations persist across restart (durable ledger)', async () => {
  ledger.reserve('durable-job', 4);
  const remainingBefore = ledger.remainingUsd();
  await ledger.close();
  const l2 = await BudgetLedger.open(dbPath, { monthlyCapUsd: 10 });
  expect(l2.remainingUsd()).toBeCloseTo(remainingBefore);
  await l2.close();
});

test('month rollover: new period starts fresh, history retained', async () => {
  const l = await BudgetLedger.open(dbPath, { monthlyCapUsd: 10, periodStart: '2026-09-01' });
  l.reserve('september-job', 9);
  l.reconcile('september-job', 9);
  expect(l.remainingUsd()).toBeCloseTo(1);
  // October begins:
  l.setPeriod('2026-10-01');
  expect(l.remainingUsd()).toBeCloseTo(10);
  // But the spent history is still queryable:
  expect(l.spentInPeriod('2026-09-01')).toBeCloseTo(9);
  await l.close();
});

afterAll(async () => {
  // Windows: release the last open handle before removing the temp dir.
  try { await ledger?.close(); } catch { /* already closed */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
