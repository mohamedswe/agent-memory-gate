import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopedPath, cleanForInference, hash, runAgent } from '../src/value-trial';
test('workspace tools reject traversal, absolute paths, private memory and dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scope-'));
  try {
    mkdirSync(join(root, 'src'));
    expect(scopedPath(root, 'src/new.ts')).toBe(join(root, 'src/new.ts'));
    for (const path of ['../secret', 'C:/secret', '.git/config', 'node_modules/key', '.project-memory/BRIEFING.md', 'src\\bad.ts']) expect(() => scopedPath(root, path)).toThrow();
  } finally { rmSync(root, { recursive: true }); }
});
test('secret-shaped tool content is withheld before inference', () => {
  expect(cleanForInference('token=verysecretvalue')).toContain('withheld');
  expect(cleanForInference('bun scripts/test.ts')).toBe('bun scripts/test.ts');
});
test('artifact fingerprints change with input', () => {
  expect(hash('same')).toBe(hash('same')); expect(hash('same')).not.toBe(hash('different'));
});
test('offline agent smoke preserves existing tests, records real commands, and accounts every inference call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trial-agent-'));
  const project = join(root, 'project'), artifacts = join(root, 'artifacts');
  mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(join(project, 'test'));
  writeFileSync(join(project, 'test/existing.test.ts'), "import {test,expect} from 'bun:test'; test('existing',()=>expect(1).toBe(1));");
  let calls = 0;
  const fn = (name: string, args: unknown, id: string) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const replies = [
    { tool_calls: [fn('write_file', { path: '../escaped.ts', content: 'bad' }, 'escape'), fn('write_file', { path: 'test/existing.test.ts', content: 'bad' }, 'immutable'), fn('write_file', { path: 'src/new.ts', content: 'export const value = 2;' }, 'write')] },
    { tool_calls: [fn('run_tests', { suite: 'focused', paths: ['test/existing.test.ts'] }, 'test')] },
    { content: 'Completed and verified.' },
  ];
  const provider = { call: async () => ({ usage: { cost: .01, prompt_tokens: 10, completion_tokens: 3 }, choices: [{ message: replies[calls++], finish_reason: 'stop' }] }) };
  try {
    const r = await runAgent(provider, project, artifacts, 'Exercise the harness.', '', 'offline-smoke');
    expect(r.status).toBe('completed'); expect(r.promptTokens).toBe(30); expect(r.costUsd).toBeCloseTo(.03);
    expect(r.tests).toBe(1); expect(r.writes).toEqual(['src/new.ts']);
    expect(existsSync(join(root, 'escaped.ts'))).toBe(false);
    expect(readFileSync(join(project, 'test/existing.test.ts'), 'utf8')).toContain("test('existing'");
    expect(r.rollout).toContain('WRITE_NOT_ALLOWED'); expect(r.rollout).toContain('EXISTING_TESTS_ARE_IMMUTABLE');
    expect(r.rollout).toContain('bun test test/existing.test.ts');
    expect(existsSync(join(artifacts, 'responses.jsonl'))).toBe(true);
  } finally { rmSync(root, { recursive: true }); }
});
test('turn-limited and failed inference attempts remain explicit outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trial-limit-'));
  const looping = { call: async () => ({ usage: { cost: .01, prompt_tokens: 10, completion_tokens: 3 }, choices: [{ message: { tool_calls: [{ id: 'list', function: { name: 'list_files', arguments: '{}' } }] }, finish_reason: 'stop' }] }) };
  try {
    const r = await runAgent(looping, root, join(root, 'logs'), 'inspect', '', 'limit', true, 1);
    expect(r.status).toBe('turn_limit'); expect(r.costUsd).toBe(.01);
    const fail = await runAgent({ call: async () => { throw new Error('offline failure'); } }, root, join(root, 'failed'), 'inspect', '', 'failed');
    expect(fail.status).toBe('failed'); expect(fail.error).toContain('offline failure');
  } finally { rmSync(root, { recursive: true }); }
});
