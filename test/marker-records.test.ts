import { expect, test } from 'bun:test';
import { renderMarkerRecord, buildTransitionCandidate, type MarkerContext } from '../src/marker-records';
import { buildUserPrompt, callReviewer } from '../src/reviewer-client';
import type { BudgetLedger } from '../src/budget-ledger';

// A marker record is DETERMINISTIC: it is built from the transition + the
// session's user turn texts, never from invented content. No inference here —
// the content is a faithful rendering of what the turns say.

const CTX: MarkerContext = {
  sessionFile: 'hermes:20261011_182709_feaab5',
  projectDir: 'C:/Users/dev/Development/Local/dual-brain-memory',
  transition: { kind: 'milestone', fromIndex: 17, toIndex: 18 },
  turns: [
    { index: 16, id: '16', text: 'status docs first lets update everything related to this project' },
    { index: 17, id: '17', text: 'yes exactly thats what I was thinking. Here is my current design push back on it' },
    { index: 18, id: '18', text: 'I have a better idea I like your proposal essentially this kills the idea of token efficiency' },
  ],
};

test('milestone marker renders attempt-kind record scoped to the project', () => {
  const rec = renderMarkerRecord(CTX);
  expect(rec.memory_kind).toBe('attempt');
  expect(rec.lifecycle).toBe('proposed');
  expect(rec.evidence).toBe('tentative');
  expect(rec.content).toContain('milestone');
  expect(rec.content.length).toBeLessThanOrEqual(300);
  // scoped: content names the project
  expect(rec.content).toContain('dual-brain-memory');
});

test('record content embeds the milestone turn text (no invention)', () => {
  const rec = renderMarkerRecord(CTX);
  // the user's own words at the transition point must appear, quoted
  expect(rec.content).toContain('I have a better idea');
});

test('recovery marker renders with failure context (the displeased turns) included', () => {
  const rec = renderMarkerRecord({
    ...CTX,
    transition: { kind: 'recovery', fromIndex: 1, toIndex: 4 },
    turns: [
      { index: 1, id: '1', text: 'no that is wrong fix it' },
      { index: 2, id: '2', text: 'still failing' },
      { index: 4, id: '4', text: 'perfect that works now' },
    ],
  });
  expect(rec.memory_kind).toBe('attempt');
  expect(rec.content).toContain('failure recovered');
  expect(rec.content).toContain('still failing');
  expect(rec.content).toContain('perfect that works now');
});

test('regression marker names the regression explicitly', () => {
  const rec = renderMarkerRecord({
    ...CTX,
    transition: { kind: 'regression', fromIndex: 3, toIndex: 5 },
    turns: [
      { index: 3, id: '3', text: 'great the build passes' },
      { index: 5, id: '5', text: 'wait now the tests fail what changed' },
    ],
  });
  expect(rec.content).toContain('regression');
  expect(rec.content).toContain('the tests fail');
});

test('unresolved marker renders the open failure honestly', () => {
  const rec = renderMarkerRecord({
    ...CTX,
    transition: { kind: 'unresolved', fromIndex: 2, toIndex: 6 },
    turns: [
      { index: 2, id: '2', text: 'the deploy is broken' },
      { index: 6, id: '6', text: 'still broken i will look tomorrow' },
    ],
  });
  expect(rec.content).toContain('unresolved');
  expect(rec.content).toContain('the deploy is broken');
});

test('long turn texts are truncated so content stays under the 300-char record contract', () => {
  const long = 'x'.repeat(500);
  const rec = renderMarkerRecord({
    ...CTX,
    transition: { kind: 'milestone', fromIndex: 0, toIndex: 1 },
    turns: [
      { index: 0, id: '0', text: long },
      { index: 1, id: '1', text: long },
    ],
  });
  expect(rec.content.length).toBeLessThanOrEqual(300);
});

test('justification states the signal source (satisfaction transition) for auditability', () => {
  const rec = renderMarkerRecord(CTX);
  expect(rec.justification).toContain('Satisfaction transition');
  expect(rec.justification.length).toBeLessThanOrEqual(200);
});

test('buildTransitionCandidate formats a satisfaction transition for the Reviewer LLM gate', async () => {
  const cand = buildTransitionCandidate(CTX);
  expect(cand.key).toContain('satisfaction:milestone:17-18');
  expect(cand.key).toContain('I have a better idea');
  const prompt = buildUserPrompt(cand);
  expect(prompt).toContain('Signal type: user satisfaction transition arc');
  expect(prompt).toContain('NOT_WORTH_SAVING');

  // Verify callReviewer can return NOT_WORTH_SAVING on a noisy transition
  const out = await callReviewer('tr-batch-1', cand, {
    httpPost: async () => ({
      ok: true,
      json: {
        choices: [{ message: { content: JSON.stringify({
          memory_kind: 'evidence',
          content: 'NOT_WORTH_SAVING',
          lifecycle: 'proposed',
          evidence: 'tentative',
          justification: 'Generic conversational approval without reusable technical lesson.',
        }) } }],
        usage: { cost: 0.002 },
      },
    }),
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: () => {},
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
    estimateUsd: () => 0.05,
  });
  expect(out.content).toBe('NOT_WORTH_SAVING');
});