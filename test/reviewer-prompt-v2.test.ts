import { expect, test } from 'bun:test';
import { buildUserPrompt } from '../src/reviewer-client';
import type { Candidate } from '../src/redaction-gate';

// Prompt v2 — the reviewer receives project context and must scope its
// content to the project, so saved memories carry their context with them.

function candidate(): Candidate {
  return {
    sessionFile: 'rollout-synthetic.jsonl',
    projectDir: 'C:/synthetic/checkout-a',
    key: 'tool:exec:input=npm run typecheck',
    counts: { userRepeats: 0, agentRediscoveries: 7, rawMentions: 7 },
  };
}

test('the reviewer prompt includes project name, session, signal type, and counts', () => {
  const prompt = buildUserPrompt(candidate());
  expect(prompt).toContain('Project: checkout-a');
  expect(prompt).toContain('Session: rollout-synthetic.jsonl');
  expect(prompt).toContain('agent repeated this action');
  expect(prompt).toContain('agentRediscoveries=7');
  expect(prompt).toContain('npm run typecheck');
});

test('prompt instructs the reviewer to scope content to the project', () => {
  const prompt = buildUserPrompt(candidate());
  expect(prompt).toMatch(/scope|context|project/i);
});
