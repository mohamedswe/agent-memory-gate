/**
 * Memory tree: group memories by MEANING, so "the same thing said in
 * different words" lands in one node. Pure: no I/O, no LLM. Vectors come
 * from an embedder (scripts/memory-tree.ts owns those, and all file access).
 *
 * Insertion follows MemTree (Rezazadeh et al., ICLR 2025, arXiv 2410.14052),
 * simplified so that no model call is ever needed:
 *  - start at the root; compare the new memory with each child's centroid;
 *  - if the best child is similar enough (threshold rises with depth), go
 *    into it; if that child is a single memory, it becomes a group of two;
 *  - otherwise the memory becomes a new child right here.
 * MemTree has an LLM rewrite every ancestor's summary on insert. Here a
 * node is just the mean of the vectors under it, and its label is its most
 * central member (the medoid), so building and labelling the tree is free.
 *
 * Behaviour then decides what matters: a node is "repeated" when its
 * members come from 2+ sessions, and its scope is "user" when they come
 * from 2+ known projects, otherwise "project".
 */
import { createHash } from 'node:crypto';
import { contentWords, UNKNOWN_PROJECT, type Source } from './correction-census';

export type Vec = Float32Array;

export interface TreeItem {
  /** Stable id: source:session:sha (see itemHash). */
  id: string;
  kind: 'correction' | 'instruction';
  text: string;
  source: Source;
  sessionKey: string;
  project: string;
  startedAt: number;
}

export interface TreeNode {
  id: number;
  depth: number;
  parent: number | null;
  children: number[];
  /** Set only on leaves: the index of the item it holds. */
  item: number | null;
  /** Sum of member vectors (the centroid direction); members = items under this node. */
  sum: Vec;
  members: number[];
}

export interface TreeOptions {
  /** Similarity needed to enter a depth-1 node. */
  base: number;
  /** Added per extra level: deeper nodes must be tighter. */
  step: number;
  /** Never require more than this. */
  cap: number;
}

export const DEFAULT_TREE: Record<string, TreeOptions> = {
  // Chosen before evaluation, not tuned on the labels: see the sweep in the eval output.
  tfidf: { base: 0.30, step: 0.10, cap: 0.90 },
  minilm: { base: 0.55, step: 0.08, cap: 0.92 },
};

export function thresholdAt(depth: number, o: TreeOptions): number {
  return Math.min(o.cap, o.base + o.step * Math.max(0, depth - 1));
}

// ------------------------------------------------------------- vector math

export function norm(v: Vec): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

export function normalize(v: Vec): Vec {
  const n = norm(v) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Cosine between a unit vector and a (summed, unnormalized) centroid. */
export function cosToSum(unit: Vec, sum: Vec): number {
  let d = 0;
  for (let i = 0; i < unit.length; i++) d += unit[i] * sum[i];
  const n = norm(sum);
  return n ? d / n : 0;
}

function addInto(sum: Vec, v: Vec): void {
  for (let i = 0; i < v.length; i++) sum[i] += v[i];
}

// ---------------------------------------------------------- tfidf embedder

/** FNV-1a, so feature hashing is identical on every machine. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Stemmed content words plus character trigrams of each word (so typos like "deskrtop" still overlap). */
export function tfidfFeatures(text: string): string[] {
  const out: string[] = [];
  for (const w of contentWords(text)) {
    out.push(`w:${w}`);
    const p = `<${w}>`;
    for (let i = 0; i + 3 <= p.length; i++) out.push(`c:${p.slice(i, i + 3)}`);
  }
  return out;
}

/**
 * Zero-dependency baseline embedder: TF-IDF over the given corpus, hashed
 * into `dims` buckets, L2-normalized. Lexical, not semantic: it is the
 * control the neural embedder has to beat.
 */
export function tfidfEmbed(texts: string[], dims = 2048): Vec[] {
  const feats = texts.map(tfidfFeatures);
  const df = new Map<string, number>();
  for (const fs of feats) for (const f of new Set(fs)) df.set(f, (df.get(f) ?? 0) + 1);
  const n = texts.length;
  return feats.map(fs => {
    const v = new Float32Array(dims);
    const tf = new Map<string, number>();
    for (const f of fs) tf.set(f, (tf.get(f) ?? 0) + 1);
    for (const [f, c] of tf) {
      const idf = Math.log((1 + n) / (1 + (df.get(f) ?? 0))) + 1;
      // Word features count double: a shared word says more than a shared trigram.
      const weight = (f.startsWith('w:') ? 2 : 1) * (1 + Math.log(c)) * idf;
      v[fnv1a(f) % dims] += weight;
    }
    return normalize(v);
  });
}

// -------------------------------------------------------------------- tree

export interface MemoryTree {
  nodes: TreeNode[];
  items: TreeItem[];
  vectors: Vec[];
  options: TreeOptions;
}

/** Build by inserting items in chronological order (how memory would grow in real use). */
export function buildTree(items: TreeItem[], vectors: Vec[], options: TreeOptions): MemoryTree {
  if (items.length !== vectors.length) throw new Error('buildTree: items and vectors differ in length');
  const dims = vectors[0]?.length ?? 0;
  const nodes: TreeNode[] = [{ id: 0, depth: 0, parent: null, children: [], item: null, sum: new Float32Array(dims), members: [] }];
  const order = items.map((_, i) => i).sort((a, b) => items[a].startedAt - items[b].startedAt || items[a].id.localeCompare(items[b].id));

  const newNode = (parent: number, item: number | null): number => {
    const id = nodes.length;
    nodes.push({ id, depth: nodes[parent].depth + 1, parent, children: [], item, sum: new Float32Array(dims), members: [] });
    nodes[parent].children.push(id);
    return id;
  };
  const credit = (from: number, item: number) => {
    for (let n: number | null = from; n !== null; n = nodes[n].parent) { addInto(nodes[n].sum, vectors[item]); nodes[n].members.push(item); }
  };

  for (const i of order) {
    const v = vectors[i];
    let at = 0;
    for (;;) {
      const node = nodes[at];
      let best = -1, bestSim = -Infinity;
      for (const c of node.children) {
        const sim = cosToSum(v, nodes[c].sum);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (best < 0 || bestSim < thresholdAt(node.depth + 1, options)) {
        credit(newNode(at, i), i);
        break;
      }
      const child = nodes[best];
      if (child.item !== null) {
        // Expand a single memory into a group of two: the old memory moves down a level.
        const old = child.item;
        child.item = null;
        const moved = newNode(best, old);
        addInto(nodes[moved].sum, vectors[old]);
        nodes[moved].members.push(old);
        credit(newNode(best, i), i);
        break;
      }
      at = best;
    }
  }
  return { nodes, items, vectors, options };
}

/** For each item, the node holding it at `depth` (its depth-`depth` ancestor, or its own leaf if shallower). */
export function clustersAtDepth(tree: MemoryTree, depth: number): number[] {
  const out = new Array<number>(tree.items.length).fill(-1);
  for (const n of tree.nodes) {
    if (n.depth === depth || (n.item !== null && n.depth < depth)) for (const m of n.members) out[m] = n.id;
  }
  return out;
}

export interface NodeSummary {
  node: number;
  depth: number;
  label: string;
  members: number;
  sessions: number;
  knownProjects: number;
  projects: string[];
  sources: Source[];
  kinds: Array<TreeItem['kind']>;
  scope: 'user' | 'project' | 'unknown';
  repeated: boolean;
  lastSeen: number;
  children: number[];
}

/** The member closest to the node's centroid: a free, faithful label (no LLM rewriting). */
export function medoid(tree: MemoryTree, node: number): number {
  const n = tree.nodes[node];
  let best = n.members[0], bestSim = -Infinity;
  for (const m of n.members) {
    const sim = cosToSum(tree.vectors[m], n.sum);
    if (sim > bestSim) { bestSim = sim; best = m; }
  }
  return best;
}

export function summarizeNode(tree: MemoryTree, node: number): NodeSummary {
  const n = tree.nodes[node];
  const its = n.members.map(m => tree.items[m]);
  const projects = [...new Set(its.map(i => i.project))].sort();
  const known = projects.filter(p => p !== UNKNOWN_PROJECT).length;
  const sessions = new Set(its.map(i => i.sessionKey)).size;
  return {
    node, depth: n.depth,
    label: tree.items[medoid(tree, node)].text,
    members: n.members.length, sessions, knownProjects: known, projects,
    sources: [...new Set(its.map(i => i.source))].sort() as Source[],
    kinds: [...new Set(its.map(i => i.kind))].sort() as Array<TreeItem['kind']>,
    scope: known >= 2 ? 'user' : known === 1 ? 'project' : 'unknown',
    repeated: sessions >= 2,
    lastSeen: Math.max(...its.map(i => i.startedAt)),
    children: n.children,
  };
}

/** Top-level nodes, most-repeated first, then most recent. */
export function topNodes(tree: MemoryTree): NodeSummary[] {
  return tree.nodes[0].children.map(c => summarizeNode(tree, c))
    .sort((a, b) => b.sessions - a.sessions || b.members - a.members || b.lastSeen - a.lastSeen || a.node - b.node);
}

const oneLine = (s: string, max = 160) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

/**
 * What a session would load: repeated nodes first (user scope, then
 * project), each with up to `zoom` sub-groups, within a line budget.
 * Compression happens here: a node of 12 corrections costs one line plus
 * its biggest sub-groups, not 12 lines.
 */
export function renderTree(tree: MemoryTree, budgetLines = 60, zoom = 3): string {
  const tops = topNodes(tree);
  const repeated = tops.filter(t => t.repeated);
  const lines: string[] = [
    '# Memory tree',
    '',
    `${tree.items.length} memories in ${tops.length} top-level groups; ${repeated.length} groups recur across sessions.`,
    'Labels are real messages (the most central one in each group), not model rewrites.',
    '',
  ];
  let used = 0;
  const node = (t: NodeSummary) => {
    if (used >= budgetLines) return;
    lines.push(`- **${oneLine(t.label)}** · ${t.sessions} sessions · ${t.members} messages · ${t.scope === 'user' ? `you (${t.knownProjects} projects)` : t.projects.join(', ')} · ${t.sources.join(', ')}`);
    used++;
    const subs = t.children.map(c => summarizeNode(tree, c)).filter(s => s.members > 1 || t.children.length <= zoom)
      .sort((a, b) => b.members - a.members || a.node - b.node).slice(0, zoom);
    for (const s of subs) {
      if (used >= budgetLines) return;
      lines.push(`  - ${oneLine(s.label, 140)} (${s.members})`);
      used++;
    }
  };
  for (const [title, group] of [
    ['About you (repeated across projects)', repeated.filter(t => t.scope === 'user')],
    ['Per project (repeated)', repeated.filter(t => t.scope === 'project')],
    ['Repeated, project unknown', repeated.filter(t => t.scope === 'unknown')],
  ] as const) {
    if (!group.length || used >= budgetLines) continue;
    lines.push(`## ${title}`, '');
    for (const t of group) node(t);
    lines.push('');
  }
  const once = tops.length - repeated.length;
  lines.push(`_${once} one-off groups not shown (said in a single session). They stay in the tree; open them with --show-all._`);
  return lines.join('\n');
}

// --------------------------------------------------------------- evaluation

/** Stable, content-free id for a message: lets labels be committed without the text. */
export function itemHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

export interface LabelFile {
  version: number;
  note?: string;
  items: Array<{ source: Source; sessionId: string; sha: string; theme: string }>;
}

export interface PairScores {
  goldPairs: number;
  predictedPairs: number;
  truePairs: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Pairwise clustering scores over the labelled universe. `gold[i]` is a
 * theme name or null (an unthemed message is its own singleton); `pred[i]`
 * is the cluster id. A pair counts when both share a theme / a cluster.
 */
export function pairScores(gold: Array<string | null>, pred: number[]): PairScores {
  let goldPairs = 0, predictedPairs = 0, truePairs = 0;
  for (let i = 0; i < gold.length; i++) {
    for (let j = i + 1; j < gold.length; j++) {
      const g = gold[i] !== null && gold[i] === gold[j];
      const p = pred[i] === pred[j];
      if (g) goldPairs++;
      if (p) predictedPairs++;
      if (g && p) truePairs++;
    }
  }
  const precision = predictedPairs ? truePairs / predictedPairs : 0;
  const recall = goldPairs ? truePairs / goldPairs : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { goldPairs, predictedPairs, truePairs, precision: r(precision), recall: r(recall), f1: r(f1) };
}

export interface ThemeResult {
  theme: string;
  items: number;
  sessions: number;
  /** Largest share of the theme's items found together in one cluster. */
  bestShare: number;
  /** Share of that cluster that belongs to the theme. */
  purity: number;
  /** All-or-most in one fairly pure cluster: >= 2/3 of items, purity >= 0.5. */
  recovered: boolean;
}

export function themeResults(gold: Array<string | null>, pred: number[], sessionOf: string[]): ThemeResult[] {
  const themes = [...new Set(gold.filter((g): g is string => g !== null))].sort();
  return themes.map(theme => {
    const idx = gold.map((g, i) => (g === theme ? i : -1)).filter(i => i >= 0);
    const counts = new Map<number, number>();
    for (const i of idx) counts.set(pred[i], (counts.get(pred[i]) ?? 0) + 1);
    let bestCluster = -1, bestCount = 0;
    for (const [c, k] of counts) if (k > bestCount || (k === bestCount && c < bestCluster)) { bestCluster = c; bestCount = k; }
    const clusterSize = pred.filter(p => p === bestCluster).length;
    const share = bestCount / idx.length, purity = clusterSize ? bestCount / clusterSize : 0;
    const r = (x: number) => Math.round(x * 100) / 100;
    return {
      theme, items: idx.length, sessions: new Set(idx.map(i => sessionOf[i])).size,
      bestShare: r(share), purity: r(purity),
      recovered: idx.length >= 2 && bestCount >= 2 && share >= 2 / 3 - 1e-9 && purity >= 0.5,
    };
  });
}
