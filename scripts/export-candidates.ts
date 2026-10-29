// Export ALL promotion candidates from every Codex session rollout to a review file.
// Outputs one JSON object per line: session, cwd (project), key, counts — no raw
// message text, no tool outputs, nothing written to any brain.
import { parseRollout, feedLedger } from '../src/rollout-reader';
import { UsageLedger } from '../src/usage-ledger';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { projectCommandContext } from '../src/project-command-context';

const sessionsRoot = resolve(process.argv[2]);
const outPath = process.argv[3];
if (!sessionsRoot || !outPath) {
  console.error('usage: bun scripts/export-candidates.ts <sessions-root> <out.jsonl>');
  process.exit(1);
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJsonl(full));
    else if (name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
const files = walkJsonl(sessionsRoot);
const lines: string[] = [];
let total = 0;

for (const path of files) {
  const rollout = parseRollout(readFileSync(path, 'utf-8'));
  const ledger = new UsageLedger(projectCommandContext(rollout.meta.cwd??''));
  feedLedger(ledger, rollout);
  for (const c of ledger.promotionCandidates()) {
    total++;
    lines.push(JSON.stringify({
      sessionFile: basename(path),
      projectDir: rollout.meta.cwd,
      key: c.key,
      counts: c.counts,
      ...(c.sourceKeys?{sourceKeys:c.sourceKeys}:{}),
    }));
  }
}

mkdirSync(outPath.split('/').slice(0, -1).join('/'), { recursive: true });
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(JSON.stringify({ sessions: files.length, candidates: total, out: outPath }));
