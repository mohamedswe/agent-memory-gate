import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSession, CaptureResult } from '../src/session-capture';

// Synthetic rollout matching observed Codex shapes; a user repeating a
// substantive statement twice promotes; single tool calls do not.
const ROLLOUT_A = [
  JSON.stringify({ type: 'session_meta', payload: { id: 's-a', cwd: 'C:/synthetic/project-x', git: { branch: 'main' }, timestamp: '2026-10-11T01:00:00.000Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-1', content: [{ type: 'input_text', text: 'run the scanner tests before committing' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-2', content: [{ type: 'input_text', text: 'Run the scanner tests before committing!' }] } }),
].join('\n');

const ROLLOUT_SECRET = [
  JSON.stringify({ type: 'session_meta', payload: { id: 's-b', cwd: 'C:/synthetic/project-x', git: { branch: 'main' }, timestamp: '2026-10-11T02:00:00.000Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-1', content: [{ type: 'input_text', text: 'my key is sk-abcdefghijklmnopqrstuvwx' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-2', content: [{ type: 'input_text', text: 'My key is sk-abcdefghijklmnopqrstuvwx!' }] } }),
].join('\n');

function makeTmp(): string { return mkdtempSync(join(tmpdir(), 'capture-test-')); }

test('captureSession extracts, redacts, and queues candidates without brain or network', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-a.jsonl');
  writeFileSync(file, ROLLOUT_A);
  const result = captureSession(file);
  expect(result.sessionFile).toBe(file);
  expect(result.projectDir).toBe('C:/synthetic/project-x');
  expect(result.queued.length).toBe(1);        // pure result: queued candidates list
  expect(result.excluded.length).toBe(0);
  expect(result.queued[0].key).toBe('run the scanner tests before committing');
  rmSync(dir, { recursive: true });
});

test('captureSession excludes secret-shaped candidates fail-closed with a reason', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-secret.jsonl');
  writeFileSync(file, ROLLOUT_SECRET);
  const result = captureSession(file);
  expect(result.queued.length).toBe(0);
  expect(result.excluded.length).toBe(1);
  expect(result.excluded[0].reason).toContain('api key');
  rmSync(dir, { recursive: true });
});

test('captureSession on a rollout with no repeats queues nothing', () => {
  const dir = makeTmp();
  const file = join(dir, 'rollout-quiet.jsonl');
  writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 's-c', cwd: 'C:/synthetic/project-x', git: { branch: 'main' }, timestamp: '2026-10-11T03:00:00.000Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'm-1', content: [{ type: 'input_text', text: 'one substantive statement only' }] } }),
  ].join('\n'));
  const result = captureSession(file);
  expect(result.queued.length).toBe(0);
  expect(result.excluded.length).toBe(0);
  rmSync(dir, { recursive: true });
});