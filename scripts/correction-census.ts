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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  recallSample, renderSample, renderStandingInstructions, runCensus, sampleEvents, standingInstructions,
} from '../src/correction-census';
import { loadSessions, sourceOptions } from './census-sources';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outDir = opt('--out-dir', 'live-run');
const sampleOpt = opt('--sample', 'all');
const sampleSize = sampleOpt === 'all' ? Infinity : Number(sampleOpt) || 50;
const recallPerSource = Number(opt('--recall', '10')) || 10;

const { sessions: kept, notes, excludedEval } = loadSessions(sourceOptions(args));

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
  excludedEvalSessions: excludedEval,
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
