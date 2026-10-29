import { expect, test } from 'bun:test';
import {
  claudeCodeSessionTurns, codexSessionTurns, correctionSignature, detectCorrections, hermesSessionTurns,
  isCorrection, isMatchableSignature, runCensus, sampleEvents, type SessionTurns,
} from '../src/correction-census';

// ---------------------------------------------------------------- detector

test('isCorrection: pushback right after an agent turn is detected', () => {
  for (const text of [
    'no, use bun scripts/test.ts',
    "don't add comments everywhere",
    'Do not touch the OneDrive clone',
    'stop running the full suite',
    "that's wrong, the cursor is per file",
    'Actually keep the old name',
    'use pnpm instead',
    'revert that change',
    'undo the last edit',
    'why did you delete the test?',
    'not like that',
    'I said no new dependencies',
  ]) expect(isCorrection(text, true)).toBe(true);
});

test('isCorrection: curly apostrophes match like straight ones', () => {
  expect(isCorrection('don\u2019t add comments', true)).toBe(true);
});

test('isCorrection: never fires without a preceding agent turn (opening prompt)', () => {
  expect(isCorrection('no, use bun scripts/test.ts', false)).toBe(false);
});

test('isCorrection: neutral or approving follow-ups are not corrections', () => {
  for (const text of ['perfect, ship it', 'looks good', 'great, now add the docs page', 'continue']) {
    expect(isCorrection(text, true)).toBe(false);
  }
});

test('isCorrection: long messages are treated as new task specs, not pushback', () => {
  const long = "don't " + 'do the following steps carefully and in order '.repeat(10);
  expect(isCorrection(long, true)).toBe(false);
});

test('isCorrection: "use"/"fix" only count at the start, not mid-sentence', () => {
  expect(isCorrection('great, we can use this later', true)).toBe(false);
  expect(isCorrection('use this later', true)).toBe(true);
});

// -------------------------------------------------------------- normalizer

test('correctionSignature: case, punctuation and emoji are stripped, whitespace collapsed', () => {
  expect(correctionSignature('  Use   PNPM, instead!! 🙄 ')).toBe('use pnpm instead');
});

test('correctionSignature: leading filler dropped repeatedly, trailing please/thanks dropped', () => {
  expect(correctionSignature('No, just please use pnpm instead, thanks')).toBe('use pnpm instead');
  expect(correctionSignature('actually stop adding comments please')).toBe('adding comments');
  expect(correctionSignature('Use pnpm instead, thank you')).toBe('use pnpm instead');
});

test('correctionSignature: dont / do not are dropped as leading filler (documented lossy collision)', () => {
  expect(correctionSignature("Don't add comments")).toBe('add comments');
  expect(correctionSignature('do not add comments')).toBe('add comments');
  expect(correctionSignature('Don\u2019t add comments')).toBe('add comments');
});

test('correctionSignature: same correction phrased with different punctuation matches', () => {
  expect(correctionSignature('No — use bun scripts/test.ts.')).toBe(correctionSignature('no, use bun scripts/test.ts'));
});

test('correctionSignature: bare pushback normalizes to a content-free signature', () => {
  expect(correctionSignature('No!')).toBe('');
  expect(isMatchableSignature(correctionSignature('No!'))).toBe(false);
  expect(isMatchableSignature(correctionSignature('revert'))).toBe(false);
  expect(isMatchableSignature(correctionSignature('revert the migration'))).toBe(true);
});

// ------------------------------------------------------------------ census

const session = (source: SessionTurns['source'], id: string, project: string, startedAt: number, userTexts: string[]): SessionTurns => ({
  source, sessionId: id, project, startedAt,
  turns: [{ role: 'user', text: 'opening task' }, ...userTexts.flatMap(text => [{ role: 'agent' as const, text: 'did a thing' }, { role: 'user' as const, text }])],
});

test('runCensus: first occurrence is not a repeat; later sessions are; cross-project is flagged', () => {
  const { report, events } = runCensus([
    session('codex', 'a', 'projects/alpha', 1, ["don't add comments"]),
    session('claude-code', 'b', 'projects/alpha', 2, ['do not add comments']),
    session('hermes', 'c', 'projects/beta', 3, ['Don\u2019t add comments!']),
    session('codex', 'd', 'projects/beta', 4, ['no']),
  ]);
  expect(report.correctionsDetected).toBe(4);
  expect(report.contentFreeCorrections).toBe(1);
  expect(report.repeatedEvents).toBe(2);
  expect(report.repeatedEventsSameProject).toBe(1); // b repeats a (same project)
  expect(report.repeatedEventsCrossProject).toBe(1); // c repeats a/b (other project)
  expect(report.repeatedCorrectionRate).toBe(0.5);
  expect(report.repeatedSignatures).toBe(1);
  expect(report.crossProjectSignatures).toBe(1);
  expect(report.crossSourceSignatures).toBe(1);
  expect(report.topCrossProjectSignatures[0].signature).toBe('add comments');
  expect(events.find(e => e.sessionId === 'a')!.repeat).toBe(false);
  expect(report.bySource.codex.corrections).toBe(2);
  expect(report.byProject['projects/beta'].repeatEvents).toBe(1);
});

test('runCensus: within-session repetition is counted separately and is not a cross-session repeat', () => {
  const { report } = runCensus([session('codex', 'a', 'projects/alpha', 1, ['use pnpm instead', 'use pnpm instead'])]);
  expect(report.withinSessionRepeatEvents).toBe(1);
  expect(report.repeatedEvents).toBe(0);
});

test('runCensus: unknown projects never produce cross-project claims', () => {
  const { report } = runCensus([
    session('hermes', 'a', 'unknown', 1, ['use pnpm instead']),
    session('codex', 'b', 'projects/alpha', 2, ['use pnpm instead']),
  ]);
  expect(report.repeatedEvents).toBe(1);
  expect(report.repeatedEventsCrossProject).toBe(0);
  expect(report.crossProjectSignatures).toBe(0);
});

test('runCensus: input order does not change results (sessions ordered by start time)', () => {
  const s = [session('codex', 'x', 'projects/a', 5, ['use pnpm instead']), session('codex', 'y', 'projects/b', 1, ['use pnpm instead'])];
  const forward = runCensus(s).report, backward = runCensus([...s].reverse()).report;
  expect(forward.repeatedEvents).toBe(backward.repeatedEvents);
  expect(runCensus(s).events.find(e => e.repeat)!.sessionId).toBe('x');
});

test('detectCorrections keeps two turns of preceding context', () => {
  const evs = detectCorrections(session('codex', 'a', 'projects/a', 1, ['use pnpm instead']));
  expect(evs[0].context.map(t => t.role)).toEqual(['user', 'agent']);
});

test('sampleEvents is deterministic and bounded', () => {
  const { events } = runCensus(Array.from({ length: 30 }, (_, i) => session('codex', `s${i}`, 'projects/a', i, ['use pnpm instead', 'revert the migration', 'no'])));
  expect(sampleEvents(events, 50)).toHaveLength(50);
  expect(sampleEvents(events, 50).map(e => e.sessionId)).toEqual(sampleEvents(events, 50).map(e => e.sessionId));
  expect(sampleEvents(events.slice(0, 5), 50)).toHaveLength(5);
});

// -------------------------------------------------------------- extractors

test('codexSessionTurns drops system-injected user content and keeps adjacency', () => {
  const lines = [
    { type: 'session_meta', payload: { id: 'sess-1', cwd: 'C:\\Users\\dev\\Development\\agent-memory-gate', timestamp: '2026-10-01T10:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'u0', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'fix the parser' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'no, use bun scripts/test.ts' }] } },
  ].map(l => JSON.stringify(l)).join('\n');
  const s = codexSessionTurns(lines, 'fallback');
  expect(s.sessionId).toBe('sess-1');
  expect(s.project).toBe('projects/agent-memory-gate');
  expect(s.startedAt).toBe(Date.parse('2026-10-01T10:00:00Z'));
  expect(s.turns.map(t => t.role)).toEqual(['user', 'agent', 'user']);
  expect(detectCorrections(s)).toHaveLength(1);
});

test('claudeCodeSessionTurns: user text (string or blocks) only; tool results and harness text are agent/ignored', () => {
  const lines = [
    { type: 'user', uuid: '1', sessionId: 'cc-1', cwd: '/home/dev/proj-x', timestamp: '2026-10-02T00:00:00Z', message: { role: 'user', content: 'refactor the ledger' } },
    { type: 'assistant', uuid: '2', sessionId: 'cc-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: '3', sessionId: 'cc-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', uuid: '4', sessionId: 'cc-1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', uuid: '5', sessionId: 'cc-1', message: { role: 'user', content: [{ type: 'text', text: "don't add comments" }] } },
    { type: 'user', uuid: '5', sessionId: 'cc-1', message: { role: 'user', content: [{ type: 'text', text: "don't add comments" }] } },
    { type: 'user', uuid: '6', sessionId: 'cc-1', isSidechain: true, message: { role: 'user', content: 'sidechain prompt' } },
  ].map(l => JSON.stringify(l)).join('\n');
  const s = claudeCodeSessionTurns(lines, 'fallback');
  expect(s.sessionId).toBe('cc-1');
  expect(s.project).toBe('projects/proj-x');
  expect(s.turns.filter(t => t.role === 'user').map(t => t.text)).toEqual(['refactor the ledger', "don't add comments"]);
  expect(detectCorrections(s)).toHaveLength(1);
});

test('hermesSessionTurns orders by id and keeps assistant/tool rows as agent context', () => {
  const s = hermesSessionTurns('h1', 'unknown', 1791700000, [
    { id: 3, role: 'user', content: 'stop adding comments' },
    { id: 1, role: 'user', content: 'write the census' },
    { id: 2, role: 'assistant', content: 'Done.' },
  ]);
  expect(s.turns.map(t => t.role)).toEqual(['user', 'agent', 'user']);
  expect(s.startedAt).toBe(1791700000 * 1000);
  expect(detectCorrections(s)).toHaveLength(1);
});
