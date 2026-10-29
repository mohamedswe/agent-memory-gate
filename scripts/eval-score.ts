/** Offline usage audit. --json uses the same accounting as eval-collect. */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseEvalMetrics } from '../src/eval-metrics';
const paths = process.argv.slice(2).filter(p => p !== '--json');
if (!paths.length) { console.error('usage: bun scripts/eval-score.ts [--json] <rollouts...>'); process.exit(1); }
const scores = paths.map(path => ({ label: basename(path), ...parseEvalMetrics(readFileSync(path, 'utf8')) }));
if (process.argv.includes('--json')) console.log(JSON.stringify(scores, null, 2));
else for (const s of scores) {
  console.log(`\n${s.label}: ${s.accounting}`);
  console.log(s.usage ?? 'USAGE UNAVAILABLE');
  console.log(`tool calls: ${s.toolCalls}; log span: ${s.elapsedSeconds ?? '?'}s`);
  for (const issue of s.issues) console.log(`warning: ${issue}`);
  for (const cmd of s.commands) console.log(`  ${cmd}`);
}
if (scores.some(s => ['missing', 'invalid'].includes(s.accounting))) process.exitCode = 2;
