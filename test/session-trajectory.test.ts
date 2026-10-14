import { expect, test } from 'bun:test';
import { extractUserTurns, buildSatisfactionJob } from '../src/session-trajectory';

// Synthetic fixtures — observed Codex rollout shapes, planted user-message
// sequence covering the satisfaction states: neutral, displeased, displeased,
// pleased (a resolve arc), and a session with no user turns at all.

const ROLLOUT_ARC = [
  JSON.stringify({ type: 'session_meta', payload: { id: 's-arc', cwd: 'C:/synthetic/project-y', git: { branch: 'main' }, timestamp: '2026-10-11T01:00:00.000Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-1', content: [{ type: 'input_text', text: 'run the tests and show me the output' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a-1', content: [{ type: 'output_text', text: 'Running tests now.' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-2', content: [{ type: 'input_text', text: 'no thats wrong the build is still failing' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a-2', content: [{ type: 'output_text', text: 'Fixed the import path.' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-3', content: [{ type: 'input_text', text: 'still failing try again' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a-3', content: [{ type: 'output_text', text: 'Adjusted the timeout.' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-4', content: [{ type: 'input_text', text: 'perfect that worked thanks' }] } }),
].join('\n');

const ROLLOUT_NO_USERS = [
  JSON.stringify({ type: 'session_meta', payload: { id: 's-empty', cwd: 'C:/synthetic/project-y', git: { branch: 'main' }, timestamp: '2026-10-11T02:00:00.000Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a-1', content: [{ type: 'output_text', text: 'Standalone assistant output.' }] } }),
].join('\n');

test('extractUserTurns returns ONLY user messages in order, indexed, assistant messages excluded', () => {
  const t = extractUserTurns(ROLLOUT_ARC);
  expect(t.projectDir).toBe('C:/synthetic/project-y');
  expect(t.turns).toHaveLength(4);
  expect(t.turns[0]).toEqual({ index: 0, id: 'u-1', text: 'run the tests and show me the output' });
  expect(t.turns[1].text).toBe('no thats wrong the build is still failing');
  expect(t.turns[3].text).toBe('perfect that worked thanks');
  // every turn id is a user message id, never an assistant one
  expect(t.turns.map(x => x.id)).toEqual(['u-1', 'u-2', 'u-3', 'u-4']);
});

test('extractUserTurns with zero user messages returns an empty turn list, not an error', () => {
  const t = extractUserTurns(ROLLOUT_NO_USERS);
  expect(t.turns).toHaveLength(0);
  expect(t.projectDir).toBe('C:/synthetic/project-y');
});

test('buildSatisfactionJob produces a queue line with job kind, session identity, and the full turn payload', () => {
  const t = extractUserTurns(ROLLOUT_ARC);
  const job = buildSatisfactionJob('rollout-arc.jsonl', t);
  expect(job.job).toBe('satisfaction-trajectory');
  expect(job.sessionFile).toBe('rollout-arc.jsonl');
  expect(job.projectDir).toBe('C:/synthetic/project-y');
  expect(job.turns).toHaveLength(4);
  expect(job.turns[2].text).toBe('still failing try again');
});

test('buildSatisfactionJob on an empty trajectory returns null (no paid call for sessions with no user turns)', () => {
  const t = extractUserTurns(ROLLOUT_NO_USERS);
  const job = buildSatisfactionJob('rollout-empty.jsonl', t);
  expect(job).toBeNull();
});

const NL = String.fromCharCode(10);
const ROLLOUT_INJECTED = [
  JSON.stringify({ type: 'session_meta', payload: { id: 's-inj', cwd: 'C:/synthetic/project-y', git: { branch: 'main' }, timestamp: '2026-10-11T04:00:00.000Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-0', content: [{ type: 'input_text', text: '<environment_context>' + NL + '<cwd>C:' + String.fromCharCode(92) + 'somewhere</cwd>' + NL + '</environment_context>' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-1', content: [{ type: 'input_text', text: '# AGENTS.md instructions' + NL + NL + '<INSTRUCTIONS>' + NL + '# Project memory (dual-brain)' + NL + 'read briefing first</INSTRUCTIONS>' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-2', content: [{ type: 'input_text', text: 'now fix the failing test' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u-3', content: [{ type: 'input_text', text: 'good that works' }] } }),
].join(NL);

test('system-injected turns (environment_context, AGENTS.md instructions) are excluded from the trajectory', () => {
  const t = extractUserTurns(ROLLOUT_INJECTED);
  expect(t.turns).toHaveLength(2);
  expect(t.turns[0].id).toBe('u-2');
  expect(t.turns[1].id).toBe('u-3');
  // indices stay dense after filtering
  expect(t.turns[0].index).toBe(0);
  expect(t.turns[1].index).toBe(1);
});

test('a session whose only user turns are injected gets NO satisfaction job', () => {
  const onlyInjections = ROLLOUT_INJECTED.split(NL).slice(0, 3).join(NL);
  const t = extractUserTurns(onlyInjections);
  expect(t.turns).toHaveLength(0);
  expect(buildSatisfactionJob('x.jsonl', t)).toBeNull();
});

test('trailing partial line is tolerated by extractUserTurns', () => {
  const truncated = ROLLOUT_ARC + '\n{"type":"response_item","payload":{"type":"me';
  const t = extractUserTurns(truncated);
  expect(t.turns).toHaveLength(4);
});