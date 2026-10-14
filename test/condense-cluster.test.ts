import { expect, test } from 'bun:test';
import { clusterRecords, CondensableRecord } from '../src/condense-cluster';

// Deterministic clustering: near-duplicate memories group by shared core
// signals (commands, paths) within a project. Singletons pass through.

function rec(id: string, projectId: string, content: string): CondensableRecord {
  return { slug: `records/${id}`, recordId: id, projectId, content };
}

test('typecheck variants cluster together; distinct commands stay apart', () => {
  const records = [
    rec('a', 'projects/software-auditor', 'In software-auditor: run type checks with `npm run typecheck` from the project root (120s timeout).'),
    rec('b', 'projects/software-auditor', 'In software-auditor, type checking is run via `npm run typecheck` from the project root with a 120s timeout.'),
    rec('c', 'projects/software-auditor', 'In software-auditor: use `npm run typecheck` as the standard verification step.'),
    rec('d', 'projects/software-auditor', 'In software-auditor: run scanner tests with `node --experimental-strip-types --test src/scanner/scanRepository.test.mjs`.'),
    rec('e', 'projects/software-auditor', 'In software-auditor: run tests with `node --experimental-strip-types --test src/parser/parseSourceFile.test.mjs`.'),
  ];
  const clusters = clusterRecords(records);
  expect(clusters).toHaveLength(3); // typecheck trio; the two node --test pairs; wait — see below
});

test('graphify doc variants cluster by shared path', () => {
  const records = [
    rec('f', 'projects/software-auditor', 'the graphify skill doc lives at C:\\Users/dev\\.codex\\skills\\graphify\\SKILL.md'),
    rec('g', 'projects/software-auditor', 'agent repeatedly reads the graphify SKILL.md at C:\\Users/dev\\.codex\\skills\\graphify\\SKILL.md'),
    rec('h', 'projects/software-auditor', 'the graphify skill documentation is located at C:\\Users/dev\\.codex\\skills\\graphify\\SKIL'),
  ];
  const clusters = clusterRecords(records);
  expect(clusters).toHaveLength(1);
  expect(clusters[0].members).toHaveLength(3);
});

test('singletons pass through as singleton clusters', () => {
  const records = [rec('z', 'projects/emara-viz', 'browser tests are run via `npm run test:browser`')];
  const clusters = clusterRecords(records);
  expect(clusters).toHaveLength(1);
  expect(clusters[0].members).toHaveLength(1);
});

test('same content in different projects never clusters together', () => {
  const records = [
    rec('p1', 'projects/emara-viz', 'use `npm run typecheck` in the project root'),
    rec('p2', 'projects/auto-apply', 'use `npm run typecheck` in the project root'),
  ];
  const clusters = clusterRecords(records);
  expect(clusters).toHaveLength(2);
});
