import { expect, test } from 'bun:test';
import { callReviewer, ReviewerDeps } from '../src/reviewer-client';
import type { Candidate } from '../src/redaction-gate';
import type { BudgetLedger } from '../src/budget-ledger';

// Reasoning-mode fallback: GLM-5.3 sometimes returns empty `content` with the
// real answer in `reasoning_content` (often wrapped in prose). The client
// must extract the JSON from the fallback instead of failing.

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
  content: 'In checkout-a: verify with npm run typecheck.',
  lifecycle: 'proposed',
  evidence: 'tentative',
  justification: 'Re-ran 7 times.',
};

function deps(content: string, reasoningContent: string): ReviewerDeps {
  return {
    httpPost: async () => ({
      ok: true,
      json: {
        choices: [{ message: { content, reasoning_content: reasoningContent } }],
        usage: { cost: 0.004 },
      },
    }),
    budget: {
      reserve: () => ({ reserved: true }),
      reconcile: () => {},
      remainingUsd: () => 10,
    } as unknown as BudgetLedger,
    estimateUsd: () => 0.05,
  };
}

test('empty content falls back to reasoning_content and extracts JSON', async () => {
  const reasoning = `Let me analyze this repeated tool call... The agent re-ran typecheck 7 times, so this is a durable procedure.\n\n{"memory_kind": "procedure", "content": "In checkout-a: verify with npm run typecheck.", "lifecycle": "proposed", "evidence": "tentative", "justification": "Re-ran 7 times."}`;
  const out = await callReviewer('reasoning-1', candidate(), deps('', reasoning));
  expect(out.memory_kind).toBe('procedure');
  expect(out.content).toContain('typecheck');
});

test('fenced JSON in reasoning_content is extracted', async () => {
  const reasoning = 'Analysis... final answer:\n```json\n' + JSON.stringify(validJson) + '\n```';
  const out = await callReviewer('reasoning-2', candidate(), deps('', reasoning));
  expect(out.content).toContain('typecheck');
});

test('both fields empty still fails honestly', async () => {
  await expect(callReviewer('reasoning-3', candidate(), deps('', ''))).rejects.toThrow();
});
