import { expect, test } from 'bun:test';
import {
  buildTree, clustersAtDepth, cosToSum, itemHash, medoid, normalize, pairScores, renderTree, summarizeNode,
  tfidfEmbed, themeResults, thresholdAt, topNodes, type TreeItem, type Vec,
} from '../src/memory-tree';

const v = (...xs: number[]): Vec => normalize(Float32Array.from(xs));
const item = (id: string, t: number, project = 'projects/a', session = id, text = id): TreeItem =>
  ({ id, kind: 'correction', text, source: 'codex', sessionKey: `codex:${session}`, project, startedAt: t });
const opts = { base: 0.8, step: 0.05, cap: 0.95 };

test('thresholdAt rises with depth and is capped', () => {
  expect(thresholdAt(1, opts)).toBeCloseTo(0.8);
  expect(thresholdAt(2, opts)).toBeCloseTo(0.85);
  expect(thresholdAt(10, opts)).toBeCloseTo(0.95);
});

test('cosToSum compares a unit vector with an unnormalized centroid', () => {
  expect(cosToSum(v(1, 0), Float32Array.from([3, 0]))).toBeCloseTo(1);
  expect(cosToSum(v(1, 0), Float32Array.from([0, 2]))).toBeCloseTo(0);
});

test('buildTree: similar memories share a node, a different one gets its own', () => {
  const items = [item('a', 1), item('b', 2), item('c', 3)];
  const t = buildTree(items, [v(1, 0.05), v(1, 0.1), v(0, 1)], opts);
  const top = t.nodes[0].children;
  expect(top).toHaveLength(2);
  const d1 = clustersAtDepth(t, 1);
  expect(d1[0]).toBe(d1[1]);
  expect(d1[2]).not.toBe(d1[0]);
  // The joined node was a leaf that expanded into a group of two leaves.
  const group = t.nodes[d1[0]];
  expect(group.item).toBeNull();
  expect(group.children.map(c => t.nodes[c].item).sort()).toEqual([0, 1]);
  expect(group.members.sort()).toEqual([0, 1]);
});

test('buildTree: insertion is chronological, not input order', () => {
  const items = [item('late', 9), item('early', 1)];
  const t = buildTree(items, [v(1, 0), v(1, 0)], opts);
  const group = t.nodes[t.nodes[0].children[0]];
  expect(t.nodes[group.children[0]].item).toBe(1); // "early" went in first
});

test('buildTree: deeper levels demand tighter similarity', () => {
  // a, b, c are all within the depth-1 threshold of each other; c is not within depth-2 of the a/b pair's leaves.
  const items = [item('a', 1), item('b', 2), item('c', 3)];
  const t = buildTree(items, [v(1, 0), v(1, 0.02), v(1, 0.6)], { base: 0.8, step: 0.15, cap: 0.99 });
  expect(t.nodes[0].children).toHaveLength(1);
  const top = t.nodes[t.nodes[0].children[0]];
  expect(top.members).toHaveLength(3);
  expect(top.children.length).toBeGreaterThanOrEqual(2);
});

test('summarizeNode: sessions and projects decide repeated and scope', () => {
  const items = [item('a', 1, 'projects/x', 's1'), item('b', 2, 'projects/y', 's2'), item('c', 3, 'projects/x', 's3'), item('d', 4, 'projects/x', 's3')];
  const t = buildTree(items, [v(1, 0), v(1, 0.01), v(0, 1), v(0.01, 1)], opts);
  const byLabel = Object.fromEntries(topNodes(t).map(n => [n.members === 2 && n.projects.length === 2 ? 'user' : 'proj', n]));
  expect(byLabel.user.scope).toBe('user');
  expect(byLabel.user.repeated).toBe(true);
  expect(byLabel.proj.scope).toBe('project');
  expect(byLabel.proj.repeated).toBe(false); // two messages, one session
});

test('medoid labels a node with its most central real message', () => {
  const items = [item('edge1', 1), item('centre', 2), item('edge2', 3)];
  const t = buildTree(items, [v(1, 0.3), v(1, 0), v(1, -0.3)], { base: 0.5, step: 0, cap: 0.5 });
  expect(items[medoid(t, t.nodes[0].children[0])].id).toBe('centre');
});

test('tfidfEmbed: typos and rewordings stay close, unrelated text does not', () => {
  const [a, b, c] = tfidfEmbed([
    'start docker desktop and validate your tests',
    'no the restart has been run start docker deskrtop and validate your tests',
    'remove the profanity checks on messages',
  ]);
  const cos = (x: Vec, y: Vec) => cosToSum(x, y);
  expect(cos(a, b)).toBeGreaterThan(0.5);
  expect(cos(a, c)).toBeLessThan(0.2);
  expect(Math.hypot(...a)).toBeCloseTo(1);
});

test('itemHash ignores whitespace differences and is 16 hex chars', () => {
  expect(itemHash('use  docker\nnow')).toBe(itemHash(' use docker now '));
  expect(itemHash('x')).toMatch(/^[0-9a-f]{16}$/);
  expect(itemHash('use docker')).not.toBe(itemHash('use podman'));
});

test('pairScores: perfect, merged-everything and split-everything cases', () => {
  const gold = ['t', 't', null, 'u', 'u'];
  expect(pairScores(gold, [0, 0, 1, 2, 2])).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  const merged = pairScores(gold, [0, 0, 0, 0, 0]);
  expect(merged.recall).toBe(1);
  expect(merged.precision).toBe(0.2);
  expect(pairScores(gold, [0, 1, 2, 3, 4])).toMatchObject({ precision: 0, recall: 0, f1: 0 });
});

test('themeResults: recovered needs 2/3 of the theme in one fairly pure cluster', () => {
  const gold = ['t', 't', 't', 'u', 'u', null];
  const r = themeResults(gold, [0, 0, 1, 2, 3, 0], ['s1', 's2', 's3', 's1', 's1', 's4']);
  const t = r.find(x => x.theme === 't')!, u = r.find(x => x.theme === 'u')!;
  expect(t).toMatchObject({ items: 3, sessions: 3, bestShare: 0.67, purity: 0.67, recovered: true });
  expect(u.recovered).toBe(false);
});

test('renderTree respects the line budget and leads with repeated groups', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(`m${i}`, i, i % 2 ? 'projects/x' : 'projects/y', `s${i}`, `message ${i}`));
  const vecs = items.map((_, i) => v(Math.cos(i), Math.sin(i), i % 3));
  const t = buildTree(items, vecs, { base: 0.6, step: 0.1, cap: 0.9 });
  const md = renderTree(t, 5);
  const bullets = md.split('\n').filter(l => /^\s*- /.test(l));
  expect(bullets.length).toBeLessThanOrEqual(5);
  expect(md).toContain('one-off groups not shown');
  expect(summarizeNode(t, 0).members).toBe(30);
});
