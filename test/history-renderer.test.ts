import { expect, test } from 'bun:test';
import { renderHistoryMarkdown } from '../src/history-renderer';

const RECORDS = [
  { kind: 'attempt', content: 'In dual-brain-memory: satisfaction milestone reached (user confirmed satisfaction): "status docs first lets update everything"', createdAt: '2026-10-11T18:27:00Z', sessionFile: 'hermes:a' },
  { kind: 'attempt', content: 'In dual-brain-memory: satisfaction failure recovered: "no that is wrong fix it" | "perfect that works now"', createdAt: '2026-10-10T21:32:00Z', sessionFile: 'hermes:b' },
  { kind: 'procedure', content: 'In dual-brain-memory: run tests with npm run test', createdAt: '2026-10-09T10:00:00Z', sessionFile: 'rollout-c' },
];

test('history renders marker records (attempt kind) as a chronological list', () => {
  const md = renderHistoryMarkdown('projects/dual-brain-memory', RECORDS);
  expect(md).toContain('# Project history — projects/dual-brain-memory');
  expect(md).toContain('milestone reached');
  expect(md).toContain('failure recovered');
});

test('procedures are NOT included — history is the marker lane only', () => {
  const md = renderHistoryMarkdown('projects/dual-brain-memory', RECORDS);
  expect(md).not.toContain('run tests with npm run test');
});

test('entries are ordered newest-first with session provenance', () => {
  const md = renderHistoryMarkdown('projects/dual-brain-memory', RECORDS);
  const milestonePos = md.indexOf('milestone reached');
  const recoveryPos = md.indexOf('failure recovered');
  expect(milestonePos).toBeGreaterThan(-1);
  expect(milestonePos).toBeLessThan(recoveryPos); // newer (10-11) before older (10-10)
  expect(md).toContain('hermes:a');
  expect(md).toContain('hermes:b');
});

test('dates are rendered human-readable per entry', () => {
  const md = renderHistoryMarkdown('projects/dual-brain-memory', RECORDS);
  expect(md).toMatch(/2026-10-11/);
  expect(md).toMatch(/2026-10-10/);
});

test('attempt-kind records without the satisfaction substring also render (agent-observed failures)', () => {
  const md = renderHistoryMarkdown('projects/dual-brain-memory', [
    { kind: 'attempt', content: 'In dual-brain-memory: writing TS via bash heredoc corrupts backslash escapes — use direct file writes', createdAt: '2026-10-12T00:00:00Z', sessionFile: 'hermes:x' },
  ]);
  expect(md).toContain('heredoc corrupts');
  expect(md).toContain('2026-10-12');
});

test('procedures still excluded even though they are records', () => {
  const md = renderHistoryMarkdown('p', [
    { kind: 'procedure', content: 'run tests with npm run test', createdAt: '2026-10-12T00:00:00Z', sessionFile: 's' },
  ]);
  expect(md).toContain('No recorded milestones');
});

test('an empty marker set renders an honest empty history', () => {
  const md = renderHistoryMarkdown('projects/dual-brain-memory', []);
  expect(md).toContain('No recorded milestones, recoveries, regressions, or unresolved failures yet.');
});