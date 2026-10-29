import { expect, test } from 'bun:test';
import {
  claudeCodeSessionTurns, cleanUserText, clusterWordSets, decodeEntities, codexSessionTurns, contentWords, correctionSignature, detectCorrections,
  fuzzyRecurrence, hermesSessionTurns, isCorrection, isDirective, isEvalProject, isMatchableSignature, recallSample,
  runCensus, sampleEvents, similarWords, splitClauses, standingInstructions, stem, type SessionTurns,
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
    'why did you stop?',
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

// ------------------------------------------------------------- v2: fuzzy


test('stem: crude suffixes collapse common variants', () => {
  expect(stem('adding')).toBe('add');
  expect(stem('added')).toBe('add');
  expect(stem('comments')).toBe('comment');
  expect(stem('stopping')).toBe('stop');
  expect(stem('process')).toBe('process');
  expect(stem('status')).toBe('status');
});

test('contentWords drops stopwords (including negation) and stems', () => {
  expect(contentWords("Stop adding comments, please!")).toEqual(['add', 'comment', 'stop']);
  expect(contentWords('no more comments')).toEqual(['comment']);
});

test('similarWords: rewordings match, unrelated corrections do not', () => {
  expect(similarWords(contentWords('stop adding comments'), contentWords('stop adding so many comments'))).toBe(true);
  expect(similarWords(contentWords('use pnpm instead'), contentWords('use pnpm not npm'))).toBe(true);
  expect(similarWords(contentWords('fix the comment in the readme'), contentWords('no more comments'))).toBe(false);
  expect(similarWords(contentWords('use pnpm instead'), contentWords('revert the migration'))).toBe(false);
  expect(similarWords([], ['x'])).toBe(false);
});

test('clusterWordSets is single-link and deterministic', () => {
  const ids = clusterWordSets([['a', 'b'], ['b', 'c'], ['x', 'y'], ['a', 'b', 'c']]);
  expect(ids[0]).toBe(ids[3]);
  expect(ids[1]).toBe(ids[3]);
  expect(ids[2]).not.toBe(ids[0]);
  expect(clusterWordSets([['a', 'b'], ['x', 'y']])).toEqual([0, 1]);
});

test('fuzzyRecurrence: only strictly earlier, different sessions count; projects are compared', () => {
  const w = ['comment', 'stop'];
  const r = fuzzyRecurrence([
    { sessionKey: 's1', project: 'projects/a', startedAt: 1, words: w },
    { sessionKey: 's1', project: 'projects/a', startedAt: 1, words: w },
    { sessionKey: 's2', project: 'projects/b', startedAt: 2, words: w },
    { sessionKey: 's3', project: 'unknown', startedAt: 3, words: w },
  ]);
  expect(r.repeat).toEqual([false, false, true, true]);
  expect(r.repeatOtherProject).toEqual([false, false, true, false]);
  expect(r.repeatSameProject).toEqual([false, false, false, false]);
});

test('runCensus: fuzzy catches the same correction in different words where exact does not', () => {
  const { report } = runCensus([
    session('codex', 'a', 'projects/alpha', 1, ['stop adding comments']),
    session('hermes', 'b', 'projects/beta', 2, ["don't add so many comments"]),
  ]);
  expect(report.repeatedEvents).toBe(0);
  expect(report.fuzzy.repeatedEvents).toBe(1);
  expect(report.fuzzy.repeatedEventsCrossProject).toBe(1);
  expect(report.fuzzy.crossProjectClusters).toBe(1);
  expect(report.bySource.hermes.fuzzyRepeatEvents).toBe(1);
  expect(report.bySource.codex.userTurnsAfterAgent).toBe(1);
});

// -------------------------------------------------------- v2: eval filter

test('isEvalProject matches experiment workspaces only', () => {
  for (const p of ['arm-a-1', 'arm-c-3', 'run-05-baseline', 'run-07-phase2', 'amg-smoke-kio5zg', 'builder-a', 'baseline', 'memory']) {
    expect(isEvalProject(`projects/${p}`)).toBe(true);
  }
  for (const p of ['agent-memory-gate', 'memory-algorithm', 'insectflux-dev', 'software-auditor', 'run-fast']) {
    expect(isEvalProject(`projects/${p}`)).toBe(false);
  }
  expect(isEvalProject('unknown')).toBe(false);
});

// ------------------------------------------------ v2: standing instructions

test('splitClauses isolates a standing rule inside a task prompt', () => {
  const clauses = splitClauses('ok pool.md has been updated fix the pipeline codex you know the vision and if you dont please ask what is unclear');
  expect(clauses).toContain('if you dont please ask what is unclear');
});

test('splitClauses keeps file names and versions whole', () => {
  expect(splitClauses('no, use bun scripts/test.ts. then run the v1.2 build')).toEqual(['use bun scripts/test.ts', 'run the v1.2 build']);
});

test('isDirective flags rules about how to work', () => {
  expect(isDirective('please ask what is unclear')).toBe(true);
  expect(isDirective('keep going until the tests pass')).toBe(true);
  expect(isDirective('the parser handles nested json')).toBe(false);
});

test('standingInstructions: a rule repeated across projects is reported once per session', () => {
  const mk = (id: string, project: string, t: number, text: string): SessionTurns =>
    ({ source: 'codex', sessionId: id, project, startedAt: t, turns: [{ role: 'user', text }] });
  const r = standingInstructions([
    mk('a', 'projects/alpha', 1, 'build the importer. if anything is unclear ask me before guessing. ask me before guessing'),
    mk('b', 'projects/beta', 2, 'fix the exporter, if something is unclear ask me before guessing'),
    mk('c', 'projects/beta', 3, 'x'.repeat(2000)),
  ]);
  expect(r.userTurnsSkippedAsPasted).toBe(1);
  expect(r.crossProjectClusters).toBe(1);
  expect(r.topCrossProject[0].sessions).toBe(2);
  expect(r.topCrossProject[0].directive).toBe(true);
});

// ------------------------------------------------------- v2: recall check

test('recallSample returns only unflagged user turns after agent turns, capped per source', () => {
  const s = session('claude-code', 'a', 'projects/a', 1, ['looks good', 'use pnpm instead', 'great, now the docs', 'ship it']);
  const items = recallSample([s], 2);
  expect(items).toHaveLength(2);
  for (const i of items) { expect(isCorrection(i.text, true)).toBe(false); expect(i.previous.role).toBe('agent'); }
});

// ------------------------------------------------- v2: detector precision

test('isCorrection v2: open why-questions are not corrections, "why did you ..." is', () => {
  for (const text of ['why did it break?', 'why is that important?', 'why does the engine keep failing', "why can't I run two sessions?"]) {
    expect(isCorrection(text, true)).toBe(false);
  }
  expect(isCorrection("why didn't you run the tests?", true)).toBe(true);
  expect(isCorrection('why are you editing the config', true)).toBe(true);
});

test('isCorrection v2: first-person "I don\'t" describes the user, not the agent', () => {
  expect(isCorrection("I don't have any API keys, give me the setup steps", true)).toBe(false);
  expect(isCorrection("i dont know, I just added regression tests", true)).toBe(false);
  expect(isCorrection("you don't need to restart the server", true)).toBe(true);
  expect(isCorrection("don't delete my projects", true)).toBe(true);
});

test('isCorrection v2: agreement or praise opened with no/nope/that\'s is not pushback', () => {
  for (const text of ["no it's fine, will it still deploy?", 'nah its ok go ahead', 'nope that makes more sense', 'no worries', "that's great progress", 'thats perfect']) {
    expect(isCorrection(text, true)).toBe(false);
  }
  expect(isCorrection('no, the output goes in the results folder', true)).toBe(true);
  expect(isCorrection("that's wrong, it should be per file", true)).toBe(true);
});

// --------------------------------------------------- v2: text cleaning

test('cleanUserText strips the Codex IDE wrapper down to the request', () => {
  const wrapped = '# Context from my IDE setup:\n\n## Active file: app/login.tsx\n\n## Open tabs:\n- login.tsx\n\n## My request for Codex:\nrefine the wording';
  expect(cleanUserText(wrapped)).toBe('refine the wording');
  expect(cleanUserText('# Context from my IDE setup:\n## Active file: x.ts')).toBe('');
});

test('cleanUserText drops client-injected [System: ...] rows and decodes entities', () => {
  expect(cleanUserText('[System: The previous response was cut off by a network error mid-stream. Continue.]')).toBe('');
  expect(cleanUserText('What is the fix&#x20; who do I ask&#32;now &amp; how')).toBe('What is the fix  who do I ask now & how');
  expect(decodeEntities('&nbsp;&lt;tag&gt;&unknown;')).toBe(' <tag>&unknown;');
});

test('hermesSessionTurns skips [System:] rows entirely, keeping real adjacency', () => {
  const s = hermesSessionTurns('h2', 'unknown', 1, [
    { id: 1, role: 'user', content: 'explain the design' },
    { id: 2, role: 'assistant', content: 'partial answer' },
    { id: 3, role: 'user', content: '[System: The previous response was cut off. Continue exactly where you left off.]' },
    { id: 4, role: 'assistant', content: 'rest of answer' },
    { id: 5, role: 'user', content: 'no, use the simpler version' },
  ]);
  expect(s.turns.filter(t => t.role === 'user').map(t => t.text)).toEqual(['explain the design', 'no, use the simpler version']);
  expect(detectCorrections(s)).toHaveLength(1);
});
