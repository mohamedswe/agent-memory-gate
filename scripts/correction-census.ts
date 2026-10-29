/**
 * correction-census.ts — repeated-correction census over real logs.
 * Deterministic, free, READ-ONLY with respect to every log source: no LLM,
 * no reviewer, no brain writes, no capture-pipeline state touched.
 *
 * Sources:
 *   Codex        ~/.codex/sessions/**\/*.jsonl
 *   Claude Code  ~/.claude/projects/**\/*.jsonl  (main sessions only: skips
 *                subagents/ dirs and agent-*.jsonl; ignores ~/.claude/history.jsonl)
 *   Hermes       ~/.hermes/profiles/edge/state.db  (opened readonly)
 *
 * Writes (only):
 *   live-run/correction-census.json            all numbers (exact + fuzzy + standing instructions)
 *   live-run/correction-census-sample.md       every correction, grouped by fuzzy cluster, + recall check
 *   live-run/standing-instructions.md          recurring clauses across sessions, for review
 *
 * Usage:
 *   bun scripts/correction-census.ts [--codex <dir>] [--claude <dir>] [--hermes-db <file>]
 *                                    [--out-dir <dir>] [--sample <n|all>] [--recall <n per source>]
 *                                    [--include-eval]
 * --include-eval keeps this repo's own experiment workspaces (arm-*, run-NN-*, amg-smoke-*, ...),
 * which are excluded by default. A missing source is reported and skipped, never fatal.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import {
  claudeCodeSessionTurns, codexSessionTurns, hermesSessionTurns, isEvalProject, projectFor, recallSample,
  renderSample, renderStandingInstructions, runCensus, sampleEvents, standingInstructions,
  type HermesRow, type SessionTurns,
} from '../src/correction-census';
import { resolveSessionProject, type ProjectMap } from '../src/hermes-attribution';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const home = homedir();
const codexRoot = opt('--codex', join(home, '.codex', 'sessions'));
const claudeRoot = opt('--claude', join(home, '.claude', 'projects'));
const hermesDb = opt('--hermes-db', join(home, '.hermes', 'profiles', 'edge', 'state.db'));
const outDir = opt('--out-dir', 'live-run');
const sampleOpt = opt('--sample', 'all');
const sampleSize = sampleOpt === 'all' ? Infinity : Number(sampleOpt) || 50;
const recallPerSource = Number(opt('--recall', '10')) || 10;
const includeEval = args.includes('--include-eval');

/** Recursive *.jsonl walk; skip(dirName) prunes directories. Sorted for determinism. */
function walkJsonl(root: string, skipDir: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) visit(p); }
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  visit(root);
  return out.sort();
}

const notes: string[] = [];
const sessions: SessionTurns[] = [];

/** Merge files that belong to the same logical session (Claude Code resumes). */
function addSession(s: SessionTurns) {
  const existing = sessions.find(x => x.source === s.source && x.sessionId === s.sessionId);
  if (!existing) { sessions.push(s); return; }
  existing.turns.push(...s.turns);
  if (s.startedAt && (!existing.startedAt || s.startedAt < existing.startedAt)) existing.startedAt = s.startedAt;
  if (existing.project === 'unknown') existing.project = s.project;
}

// --- Codex
if (existsSync(codexRoot)) {
  const files = walkJsonl(codexRoot);
  for (const f of files) {
    try {
      const s = codexSessionTurns(readFileSync(f, 'utf-8'), basename(f, '.jsonl'));
      if (!s.startedAt) s.startedAt = statSync(f).mtimeMs;
      addSession(s);
    } catch (err) { notes.push(`codex: unreadable ${f}: ${(err as Error).message}`); }
  }
  notes.push(`codex: ${files.length} files`);
} else notes.push(`codex: not found at ${codexRoot} (skipped)`);

// --- Claude Code (main sessions only)
if (existsSync(claudeRoot)) {
  const files = walkJsonl(claudeRoot, name => name === 'subagents')
    .filter(f => !basename(f).startsWith('agent-') && basename(f) !== 'history.jsonl');
  for (const f of files) {
    try {
      const s = claudeCodeSessionTurns(readFileSync(f, 'utf-8'), basename(f, '.jsonl'));
      if (!s.startedAt) s.startedAt = statSync(f).mtimeMs;
      if (s.turns.length) addSession(s);
    } catch (err) { notes.push(`claude-code: unreadable ${f}: ${(err as Error).message}`); }
  }
  notes.push(`claude-code: ${files.length} main-session files`);
} else notes.push(`claude-code: not found at ${claudeRoot} (skipped)`);

// --- Hermes (readonly)
if (existsSync(hermesDb)) {
  const mapPath = join('live-run', 'hermes-project-map.json');
  let projectMap: ProjectMap = null;
  if (existsSync(mapPath)) { try { projectMap = JSON.parse(readFileSync(mapPath, 'utf-8')); } catch { projectMap = null; } }
  const db = new Database(hermesDb, { readonly: true });
  try {
    const rows = db.query('SELECT s.id AS sid, s.cwd AS cwd, s.started_at AS started_at, m.id AS id, m.role AS role, m.content AS content FROM sessions s JOIN messages m ON m.session_id = s.id ORDER BY s.id, m.id').all() as
      Array<{ sid: string; cwd: string | null; started_at: unknown; id: number; role: string; content: string | null }>;
    const bySession = new Map<string, { cwd: string | null; startedAt: unknown; rows: HermesRow[] }>();
    for (const r of rows) {
      const entry = bySession.get(r.sid) ?? { cwd: r.cwd, startedAt: r.started_at, rows: [] };
      entry.rows.push({ id: r.id, role: r.role, content: typeof r.content === 'string' ? r.content : r.content == null ? null : String(r.content) });
      bySession.set(r.sid, entry);
    }
    for (const [sid, e] of bySession) {
      const dir = resolveSessionProject(projectMap, `hermes:${sid}`, e.cwd);
      addSession(hermesSessionTurns(sid, projectFor(dir), e.startedAt, e.rows));
    }
    notes.push(`hermes: ${bySession.size} sessions${projectMap ? ' (project map loaded)' : ''}`);
  } finally { db.close(); }
} else notes.push(`hermes: not found at ${hermesDb} (skipped)`);

// --- Eval-workspace filter
const excludedEval: Record<string, number> = {};
const kept = includeEval ? sessions : sessions.filter(s => {
  if (!isEvalProject(s.project)) return true;
  excludedEval[s.project] = (excludedEval[s.project] ?? 0) + 1;
  return false;
});
const excludedCount = sessions.length - kept.length;
notes.push(includeEval ? 'eval workspaces: included (--include-eval)' : `eval workspaces: excluded ${excludedCount} sessions`);

// --- Census
const { report, events } = runCensus(kept);
const instructions = standingInstructions(kept);
const recall = recallSample(kept, recallPerSource);
const sample = Number.isFinite(sampleSize) ? sampleEvents(events, sampleSize) : events;

mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'correction-census.json');
const mdPath = join(outDir, 'correction-census-sample.md');
const siPath = join(outDir, 'standing-instructions.md');
writeFileSync(jsonPath, JSON.stringify({
  version: 2, ...report,
  excludedEvalSessions: { count: excludedCount, byProject: excludedEval },
  standingInstructions: instructions,
  recallCheck: { items: recall.length, perSource: recallPerSource },
  notes,
}, null, 2) + '\n');
writeFileSync(mdPath, renderSample(sample, events.length, recall) + '\n');
writeFileSync(siPath, renderStandingInstructions(instructions) + '\n');

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fz = report.fuzzy;
console.log('Repeated-correction census (v2)');
for (const n of notes) console.log(`  ${n}`);
console.log(`  sessions scanned:        ${report.sessionsScanned}`);
console.log(`  user turns:              ${report.userTurns}`);
console.log(`  corrections detected:    ${report.correctionsDetected} (${report.contentFreeCorrections} content-free)`);
console.log('  EXACT matching');
console.log(`    repeated signatures:   ${report.repeatedSignatures} (${report.crossProjectSignatures} cross-project, ${report.crossSourceSignatures} cross-agent)`);
console.log(`    repeated events:       ${report.repeatedEvents} (${report.repeatedEventsSameProject} same-project, ${report.repeatedEventsCrossProject} cross-project; ${report.withinSessionRepeatEvents} within-session)`);
console.log(`    rate:                  ${pct(report.repeatedCorrectionRate)} (cross-project ${pct(report.crossProjectRepeatRate)})`);
console.log('  FUZZY matching (content words)');
console.log(`    repeated clusters:     ${fz.repeatedClusters} (${fz.crossProjectClusters} cross-project, ${fz.crossSourceClusters} cross-agent)`);
console.log(`    repeated events:       ${fz.repeatedEvents} (${fz.repeatedEventsSameProject} same-project, ${fz.repeatedEventsCrossProject} cross-project)`);
console.log(`    rate:                  ${pct(fz.repeatedCorrectionRate)} (cross-project ${pct(fz.crossProjectRepeatRate)})`);
console.log('  by source                sessions  turns  after-agent  corrections  exact  fuzzy');
for (const [src, b] of Object.entries(report.bySource)) {
  console.log(`    ${src.padEnd(20)} ${String(b.sessions).padStart(8)} ${String(b.userTurns).padStart(6)} ${String(b.userTurnsAfterAgent).padStart(12)} ${String(b.corrections).padStart(12)} ${String(b.repeatEvents).padStart(6)} ${String(b.fuzzyRepeatEvents).padStart(6)}`);
}
console.log('  STANDING INSTRUCTIONS (all user turns)');
console.log(`    clauses:               ${instructions.clauses} from ${instructions.userTurnsScanned - instructions.userTurnsSkippedAsPasted} turns (${instructions.userTurnsSkippedAsPasted} long turns skipped as pasted)`);
console.log(`    recurring clusters:    ${instructions.recurringClusters} (${instructions.crossProjectClusters} cross-project, ${instructions.crossSourceClusters} cross-agent, ${instructions.directiveRecurringClusters} directive)`);
for (const c of instructions.topCrossProject.slice(0, 5)) console.log(`      ${String(c.sessions).padStart(3)} sessions ${c.knownProjects} projects  "${c.examples[0].slice(0, 70)}"`);
console.log(`  wrote ${jsonPath}`);
console.log(`  wrote ${mdPath} (${sample.length} corrections + ${recall.length} recall-check turns)`);
console.log(`  wrote ${siPath}`);
