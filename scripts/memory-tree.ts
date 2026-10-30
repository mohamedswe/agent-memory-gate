/**
 * memory-tree.ts — group your corrections and standing instructions by
 * meaning, and check the grouping against hand-made labels.
 * READ-ONLY over the logs (same loader as the census). No LLM calls.
 *
 * Inputs (all from the user's own logs, via scripts/census-sources.ts):
 *   - corrections found by the census detector;
 *   - directive-shaped clauses ("keep it brief", "validate this claim
 *     before working on it") from other user turns.
 *
 * Embedders (--embedder):
 *   tfidf   default, zero dependencies; lexical control (word + character-trigram TF-IDF)
 *   minilm  all-MiniLM-L6-v2 via transformers.js:  bun add @huggingface/transformers
 *   python  the same model via Python:             pip install sentence-transformers
 * Both model embedders run locally; the model downloads once (~90 MB) from
 * Hugging Face, and no message text leaves the machine.
 *
 * Writes (only):
 *   live-run/memory-tree.md         what a session would load (budgeted)
 *   live-run/memory-tree.json       every node, member and label (local; contains your text)
 *   live-run/memory-tree-eval.json  scores vs. labels, threshold sweep, baselines
 *   live-run/tree-cache/<embedder>.json   embedding cache keyed by text hash
 *
 * Usage:
 *   bun scripts/memory-tree.ts [--embedder tfidf|minilm|python] [--python <cmd>]
 *                              [--labels <file>] [--no-sweep] [--base N] [--step N]
 *                              [--budget N] [--out-dir <dir>] [--include-eval]
 *                              [--codex <dir>] [--claude <dir>] [--hermes-db <file>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clusterWordSets, contentWords, correctionSignature, instructionClauses, isDirective, runCensus,
} from '../src/correction-census';
import {
  buildTree, clustersAtDepth, DEFAULT_TREE, itemHash, pairScores, renderTree, summarizeNode, tfidfEmbed,
  themeResults, topNodes, type LabelFile, type TreeItem, type TreeOptions, type Vec,
} from '../src/memory-tree';
import { loadSessions, sourceOptions } from './census-sources';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const here = dirname(fileURLToPath(import.meta.url));

const embedder = opt('--embedder', 'tfidf');
if (!['tfidf', 'minilm', 'python'].includes(embedder)) throw new Error(`unknown --embedder ${embedder} (tfidf | minilm | python)`);
const defaults = DEFAULT_TREE[embedder === 'tfidf' ? 'tfidf' : 'minilm'];
const treeOptions: TreeOptions = { ...defaults, base: Number(opt('--base', String(defaults.base))), step: Number(opt('--step', String(defaults.step))) };
const outDir = opt('--out-dir', 'live-run');
const budget = Number(opt('--budget', '60')) || 60;
const labelsPath = opt('--labels', join(here, '..', 'experiments', 'memory-tree', 'labels-v1.json'));
const sweep = !args.includes('--no-sweep');
const MODEL = 'all-MiniLM-L6-v2';

// --------------------------------------------------------------- items

const { sessions, notes } = loadSessions(sourceOptions(args));
const { events } = runCensus(sessions);
const correctionTurns = new Set(events.map(e => `${e.source}:${e.sessionId}#${e.turnIndex}`));

const items: TreeItem[] = [];
const labelKey: string[] = []; // source:session:sha, to match labels
for (const e of events) {
  const sha = itemHash(e.text);
  items.push({ id: `${e.source}:${e.sessionId}:${sha}`, kind: 'correction', text: e.text, source: e.source, sessionKey: `${e.source}:${e.sessionId}`, project: e.project, startedAt: e.startedAt });
  labelKey.push(`${e.source}:${e.sessionId}:${sha}`);
}
const nCorrections = items.length;
const seenInstruction = new Set<string>();
for (const c of instructionClauses(sessions).items) {
  if (correctionTurns.has(`${c.sessionKey}#${c.turnIndex}`) || !isDirective(c.text)) continue;
  const sha = itemHash(c.text);
  const id = `${c.sessionKey}:${sha}`;
  if (seenInstruction.has(id)) continue; // the same clause twice in one session is one observation
  seenInstruction.add(id);
  items.push({ id, kind: 'instruction', text: c.text, source: c.source, sessionKey: c.sessionKey, project: c.project, startedAt: c.startedAt });
  labelKey.push(id);
}

// ------------------------------------------------------------ embedding

async function embedWithModel(texts: string[]): Promise<number[][]> {
  if (embedder === 'python') {
    const python = opt('--python', process.platform === 'win32' ? 'python' : 'python3');
    const r = spawnSync(python, [join(here, 'embed.py'), MODEL], {
      input: JSON.stringify(texts), maxBuffer: 1 << 30, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (r.error || r.status !== 0) {
      throw new Error(`python embedder failed (${r.error?.message ?? `exit ${r.status}`}). Install with: pip install sentence-transformers\n${r.stderr?.toString().slice(-800) ?? ''}`);
    }
    return JSON.parse(r.stdout.toString('utf-8'));
  }
  // A variable specifier keeps the bundler from requiring this optional package.
  const pkg = '@huggingface/transformers';
  let mod: any;
  try { mod = await import(pkg); } catch {
    throw new Error('minilm embedder needs transformers.js: run `bun add @huggingface/transformers`, or use --embedder python');
  }
  const extract = await mod.pipeline('feature-extraction', `Xenova/${MODEL}`);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await extract(texts.slice(i, i + 32), { pooling: 'mean', normalize: true });
    out.push(...(t.tolist() as number[][]));
  }
  return out;
}

async function embed(texts: string[]): Promise<Vec[]> {
  if (embedder === 'tfidf') return tfidfEmbed(texts);
  const cacheDir = join(outDir, 'tree-cache');
  const cachePath = join(cacheDir, `${embedder}-${MODEL}.json`);
  let cache: Record<string, number[]> = {};
  if (existsSync(cachePath)) { try { cache = JSON.parse(readFileSync(cachePath, 'utf-8')); } catch { cache = {}; } }
  const keys = texts.map(itemHash);
  const missing = [...new Set(texts.filter((_, i) => !cache[keys[i]]))];
  if (missing.length) {
    console.log(`  embedding ${missing.length} new texts with ${MODEL} (${embedder})…`);
    const vecs = await embedWithModel(missing);
    missing.forEach((t, i) => { cache[itemHash(t)] = vecs[i]; });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  return keys.map(k => Float32Array.from(cache[k]));
}

let vectors: Vec[];
try { vectors = await embed(items.map(i => i.text)); } catch (err) {
  console.error(`memory-tree: ${(err as Error).message}`);
  process.exit(1);
}

// ----------------------------------------------------------------- tree

const tree = buildTree(items, vectors, treeOptions);
const tops = topNodes(tree);
mkdirSync(outDir, { recursive: true });
const mdPath = join(outDir, 'memory-tree.md');
const jsonPath = join(outDir, 'memory-tree.json');
writeFileSync(mdPath, renderTree(tree, budget) + '\n');
writeFileSync(jsonPath, JSON.stringify({
  generatedAt: new Date().toISOString(), embedder, model: embedder === 'tfidf' ? 'tfidf-hashed-2048' : MODEL, options: treeOptions,
  items: items.map(i => ({ ...i })),
  nodes: tree.nodes.map(n => ({ ...summarizeNode(tree, n.id), parent: n.parent, item: n.item, memberIds: n.members.map(m => items[m].id) })),
  notes,
}, null, 1) + '\n');

// ----------------------------------------------------------- evaluation

let evalOut: Record<string, unknown> | null = null;
if (existsSync(labelsPath)) {
  const labels = JSON.parse(readFileSync(labelsPath, 'utf-8')) as LabelFile;
  const themeOf = new Map(labels.items.map(l => [`${l.source}:${l.sessionId}:${l.sha}`, l.theme]));
  const universe = items.map((_, i) => i).filter(i => i < nCorrections); // labels cover corrections only
  const gold = universe.map(i => themeOf.get(labelKey[i]) ?? null);
  const sessionOf = universe.map(i => items[i].sessionKey);
  const matched = new Set(universe.map(i => labelKey[i]).filter(k => themeOf.has(k)));

  const score = (pred: number[]) => ({ pairs: pairScores(gold, pred), themes: themeResults(gold, pred, sessionOf) });
  const summarizeThemes = (t: ReturnType<typeof themeResults>) => ({
    recovered: t.filter(x => x.recovered).length,
    crossSessionRecovered: t.filter(x => x.recovered && x.sessions >= 2).length,
  });

  // Baselines on the same universe.
  const exactIds = new Map<string, number>();
  const exact = universe.map(i => { const s = correctionSignature(items[i].text) || `#${i}`; if (!exactIds.has(s)) exactIds.set(s, exactIds.size); return exactIds.get(s)!; });
  const words = clusterWordSets(universe.map(i => contentWords(items[i].text)));

  // The tree as built (corrections + instructions), read at depth 1 and 2.
  const d1 = clustersAtDepth(tree, 1), d2 = clustersAtDepth(tree, 2);
  const asBuilt = { depth1: score(universe.map(i => d1[i])), depth2: score(universe.map(i => d2[i])) };

  // Threshold sweep on a corrections-only tree (the same insertion rule).
  const sweepRows: Array<Record<string, unknown>> = [];
  if (sweep) {
    const cItems = universe.map(i => items[i]), cVecs = universe.map(i => vectors[i]);
    for (let b = 0.15; b <= 0.851; b += 0.05) {
      const base = Math.round(b * 100) / 100;
      const t = buildTree(cItems, cVecs, { ...treeOptions, base });
      const s = score(clustersAtDepth(t, 1));
      sweepRows.push({ base, topGroups: t.nodes[0].children.length, ...s.pairs, ...summarizeThemes(s.themes) });
    }
  }

  const exactS = score(exact), wordsS = score(words);
  evalOut = {
    generatedAt: new Date().toISOString(),
    labels: { file: labelsPath, labelled: labels.items.length, matchedInThisRun: matched.size, note: labels.note },
    embedder, options: treeOptions, corrections: nCorrections, instructions: items.length - nCorrections,
    baselines: {
      exactSignature: { ...exactS, ...summarizeThemes(exactS.themes) },
      wordOverlap: { ...wordsS, ...summarizeThemes(wordsS.themes) },
    },
    tree: {
      depth1: { ...asBuilt.depth1, ...summarizeThemes(asBuilt.depth1.themes) },
      depth2: { ...asBuilt.depth2, ...summarizeThemes(asBuilt.depth2.themes) },
    },
    sweep: sweepRows,
  };
  writeFileSync(join(outDir, 'memory-tree-eval.json'), JSON.stringify(evalOut, null, 2) + '\n');
}

// -------------------------------------------------------------- summary

const repeated = tops.filter(t => t.repeated);
console.log(`Memory tree (${embedder}${embedder === 'tfidf' ? '' : `, ${MODEL}`}; base ${treeOptions.base}, step ${treeOptions.step})`);
for (const n of notes) console.log(`  ${n}`);
console.log(`  memories:               ${items.length} (${nCorrections} corrections, ${items.length - nCorrections} directive clauses)`);
console.log(`  top-level groups:       ${tops.length} (${repeated.length} recur across sessions: ${repeated.filter(t => t.scope === 'user').length} about you, ${repeated.filter(t => t.scope === 'project').length} per project)`);
for (const t of repeated.slice(0, 8)) console.log(`    ${String(t.sessions).padStart(3)} sessions ${t.scope.padEnd(7)} "${t.label.replace(/\s+/g, ' ').slice(0, 70)}"`);
if (evalOut) {
  const e = evalOut as any;
  const row = (name: string, s: any) => console.log(`    ${name.padEnd(22)} P ${s.pairs.precision.toFixed(2)}  R ${s.pairs.recall.toFixed(2)}  F1 ${s.pairs.f1.toFixed(2)}  themes ${s.recovered}/${s.themes.length} (cross-session ${s.crossSessionRecovered})`);
  console.log(`  EVAL vs labels (${e.labels.matchedInThisRun}/${e.labels.labelled} labelled corrections found in this run)`);
  row('exact signature', e.baselines.exactSignature);
  row('word overlap', e.baselines.wordOverlap);
  row('tree, depth 1', e.tree.depth1);
  row('tree, depth 2', e.tree.depth2);
  if (e.labels.matchedInThisRun < e.labels.labelled * 0.8) console.log('    warning: fewer than 80% of labels matched; scores cover only what matched');
  if (e.sweep.length) {
    console.log('  threshold sweep (corrections-only tree, depth 1):');
    console.log('    base  groups   P     R     F1   themes');
    for (const r of e.sweep) console.log(`    ${r.base.toFixed(2)}  ${String(r.topGroups).padStart(5)}  ${r.precision.toFixed(2)}  ${r.recall.toFixed(2)}  ${r.f1.toFixed(2)}  ${r.recovered}`);
  }
} else console.log(`  no labels at ${labelsPath}; skipped evaluation`);
console.log(`  wrote ${mdPath}`);
console.log(`  wrote ${jsonPath}`);
if (evalOut) console.log(`  wrote ${join(outDir, 'memory-tree-eval.json')}`);
