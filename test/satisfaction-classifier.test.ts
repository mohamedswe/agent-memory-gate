import { expect, test } from 'bun:test';
import { classifySatisfaction, buildSatisfactionPrompt, SatisfactionDeps } from '../src/satisfaction-classifier';
import type { UserTurn } from '../src/session-trajectory';

// Deterministic stub deps: cheap reserve, real reconcile, no network.
function makeDeps(overrides?: { httpJson?: unknown; ok?: boolean }): {
  deps: SatisfactionDeps;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const reconciled: number[] = [];
  const deps: SatisfactionDeps = {
    httpPost: async (url, body) => {
      calls.push({ url, body });
      return { ok: overrides?.ok ?? true, json: overrides?.httpJson ?? {} };
    },
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: (_k, usd) => { reconciled.push(usd); },
      remainingUsd: () => 3.0,
    },
    estimateUsd: () => 0.05,
  };
  return { deps, calls };
}

function okJson(verdicts: Record<string, unknown>): unknown {
  return { choices: [{ message: { content: JSON.stringify(verdicts) } }], usage: { cost: 0.005 } };
}

const TURNS: UserTurn[] = [
  { index: 0, id: 'u-1', text: 'run the tests' },
  { index: 1, id: 'u-2', text: 'no that broke it' },
  { index: 2, id: 'u-3', text: 'good that works now' },
];

test('buildSatisfactionPrompt embeds every turn text in order with indices', async () => {
  const prompt = buildSatisfactionPrompt(TURNS);
  expect(prompt).toContain('[0] run the tests');
  expect(prompt).toContain('[1] no that broke it');
  expect(prompt).toContain('[2] good that works now');
  expect(prompt.indexOf('[0]')).toBeLessThan(prompt.indexOf('[1]'));
  expect(prompt.indexOf('[1]')).toBeLessThan(prompt.indexOf('[2]'));
});

test('classifySatisfaction returns per-turn verdicts for a valid response', async () => {
  const { deps, calls } = makeDeps({ httpJson: okJson({ verdicts: [
    { index: 0, state: 'neutral' },
    { index: 1, state: 'displeased' },
    { index: 2, state: 'pleased' },
  ] }) });
  const result = await classifySatisfaction('job-1', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS }, deps);
  expect(result.turns).toHaveLength(3);
  expect(result.turns[0].state).toBe('neutral');
  expect(result.turns[1].state).toBe('displeased');
  expect(result.turns[2].state).toBe('pleased');
  expect(result.costUsd).toBe(0.005);
  // one HTTP call only — batching invariant
  expect(calls).toHaveLength(1);
});

test('verdicts may only be neutral/pleased/displeased — anything else is rejected', async () => {
  const { deps } = makeDeps({ httpJson: okJson({ verdicts: [
    { index: 0, state: 'angry' },
  ] }) });
  let threw = '';
  try { await classifySatisfaction('job-2', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS.slice(0, 1) }, deps); }
  catch (e) { threw = String(e); }
  expect(threw).toContain('SATISFACTION_INVALID_VERDICT');
});

test('every turn must have exactly one verdict — missing or duplicate indices are rejected', async () => {
  const missing = makeDeps({ httpJson: okJson({ verdicts: [
    { index: 0, state: 'neutral' },
  ] }) });
  let threw = '';
  try { await classifySatisfaction('job-3', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS }, missing.deps); }
  catch (e) { threw = String(e); }
  expect(threw).toContain('SATISFACTION_VERDICT_MISMATCH');

  const dup = makeDeps({ httpJson: okJson({ verdicts: [
    { index: 0, state: 'neutral' },
    { index: 1, state: 'pleased' },
    { index: 2, state: 'pleased' },
    { index: 2, state: 'pleased' },
  ] }) });
  threw = '';
  try { await classifySatisfaction('job-4', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS }, dup.deps); }
  catch (e) { threw = String(e); }
  expect(threw).toContain('SATISFACTION_VERDICT_MISMATCH');
});

test('budget refusal means NO http call happens', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const deps: SatisfactionDeps = {
    httpPost: async (url, body) => { calls.push({ url, body }); return { ok: true, json: {} }; },
    budget: {
      reserve: () => ({ reserved: false, reason: 'cap' }),
      reconcile: () => { throw new Error('must not reconcile'); },
      remainingUsd: () => 0,
    },
    estimateUsd: () => 0.05,
  };
  let threw = '';
  try { await classifySatisfaction('job-5', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS }, deps); }
  catch (e) { threw = String(e); }
  expect(threw).toContain('SATISFACTION_BUDGET_REFUSED');
  expect(calls).toHaveLength(0);
});

test('HTTP failure reconciles cost (if reported) then rejects', async () => {
  const reconciled: number[] = [];
  const deps: SatisfactionDeps = {
    httpPost: async () => ({ ok: false, json: { usage: { cost: 0.004 } } }),
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: (_k, cost) => { reconciled.push(cost); },
      remainingUsd: () => 3,
    },
    estimateUsd: () => 0.05,
  };
  let threw = '';
  try { await classifySatisfaction('job-6', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS }, deps); }
  catch (e) { threw = String(e); }
  expect(threw).toContain('SATISFACTION_HTTP_NOT_OK');
  expect(reconciled).toEqual([0.004]); // tokens were spent — ledger stays honest
});

test('empty content with valid JSON in reasoning_content is recovered (same fallback as reviewer)', async () => {
  const reasoning = 'thinking... ' + JSON.stringify({ verdicts: [{ index: 0, state: 'neutral' }] }) + ' more thought';
  const deps: SatisfactionDeps = {
    httpPost: async () => ({ ok: true, json: { choices: [{ message: { content: '', reasoning_content: reasoning } }], usage: { cost: 0.002 } } }),
    budget: { reserve: () => ({ reserved: true }), reconcile: () => {}, remainingUsd: () => 3 },
    estimateUsd: () => 0.05,
  };
  const result = await classifySatisfaction('job-7', { job: 'satisfaction-trajectory', sessionFile: 's.jsonl', projectDir: 'C:/p', branch: null, turns: TURNS.slice(0, 1) }, deps);
  expect(result.turns[0].state).toBe('neutral');
});