import { expect, test } from 'bun:test';
import { callReviewer, ReviewerDeps } from '../src/reviewer-client';
import type { Candidate } from '../src/redaction-gate';
import type { BudgetLedger } from '../src/budget-ledger';

// Reviewer client — the ONLY stage that talks to paid inference. Unit-tested
// with stubbed HTTP + a real temp budget ledger: no live calls in tests.

function candidate(): Candidate {
  return {
    sessionFile: 'rollout-synthetic.jsonl',
    projectDir: 'C:/synthetic/checkout-a',
    key: 'tool:exec:input=npm run typecheck',
    counts: { userRepeats: 0, agentRediscoveries: 7, rawMentions: 7 },
  };
}

const validJson = {
  memory_kind: 'procedure',
  content: 'Verify loop: npm test then npm run typecheck from the project root.',
  lifecycle: 'proposed',
  evidence: 'tentative',
  justification: 'Agent re-ran the same verify commands 7 times.',
};

function makeDeps(overrides: Partial<ReviewerDeps> = {}): ReviewerDeps {
  return {
    httpPost: async () => { throw new Error('not stubbed'); },
    budget: {
      reserve: (key: string, amt: number) => ({ reserved: amt <= 10, reason: amt > 10 ? 'cap' : undefined }),
      reconcile: () => {},
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
    estimateUsd: () => 0.05,
    ...overrides,
  };
}

test('happy path: reserve -> call -> reconcile with actual cost', async () => {
  let reservedKey = '';
  let reconciled: { key: string; actual: number } | null = null;
  const deps = makeDeps({
    httpPost: async () => ({
      ok: true,
      json: {
        choices: [{ message: { content: '```json\n' + JSON.stringify(validJson) + '\n```' } }],
        usage: { cost: 0.012 },
      },
    }),
    budget: {
      reserve: (key: string) => { reservedKey = key; return { reserved: true }; },
      reconcile: (key: string, actual: number) => { reconciled = { key, actual }; },
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
  });

  const out = await callReviewer('batch-1', candidate(), deps);

  expect(out.memory_kind).toBe('procedure');
  expect(out.content).toContain('npm test');
  expect(reservedKey).toBe('batch-1');
  expect(reconciled).toEqual({ key: 'batch-1', actual: 0.012 });
});

test('refusal at the cap: no HTTP call is made', async () => {
  let called = false;
  const deps = makeDeps({
    httpPost: async () => { called = true; throw new Error('must not be called'); },
    budget: {
      reserve: () => ({ reserved: false, reason: 'cap: requested 0.05 exceeds remaining 0.02' }),
      reconcile: () => {},
      remainingUsd: () => 0.02,
    } as unknown as BudgetLedger,
  });

  await expect(callReviewer('batch-2', candidate(), deps)).rejects.toThrow(/cap/);
  expect(called).toBe(false);
});

test('ambiguous HTTP failure keeps the reservation held (no reconcile, no free retry)', async () => {
  let reconciled = false;
  const deps = makeDeps({
    httpPost: async () => { throw new Error('ETIMEDOUT'); }, // ambiguous: request may have landed
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: () => { reconciled = true; },
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
  });

  await expect(callReviewer('flaky-batch', candidate(), deps)).rejects.toThrow(/ETIMEDOUT/);
  expect(reconciled).toBe(false); // reservation stays held in the ledger
});

test('malformed model JSON is rejected and cost still reconciled', async () => {
  let reconciledActual = -1;
  const deps = makeDeps({
    httpPost: async () => ({
      ok: true,
      json: {
        choices: [{ message: { content: 'not json at all' } }],
        usage: { cost: 0.004 },
      },
    }),
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: (_k: string, actual: number) => { reconciledActual = actual; },
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
  });

  // The tokens were spent, so the cost IS reconciled; the output is rejected.
  await expect(callReviewer('bad-json-batch', candidate(), deps)).rejects.toThrow();
  expect(reconciledActual).toBe(0.004);
});

test('reviewer claiming verified is rejected downstream by the validator contract', async () => {
  const fraudulent = { ...validJson, evidence: 'verified' };
  const deps = makeDeps({
    httpPost: async () => ({
      ok: true,
      json: {
        choices: [{ message: { content: JSON.stringify(fraudulent) } }],
        usage: { cost: 0.004 },
      },
    }),
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: () => {},
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
  });

  await expect(callReviewer('fraud-batch', candidate(), deps)).rejects.toThrow();
});
