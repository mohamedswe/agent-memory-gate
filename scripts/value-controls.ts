/** Offline positive controls. Reference fixes are never put in trial inputs. */
import { cpSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { command } from '../src/value-trial';
const root = resolve('.eval-local/value-v1');
const specs = [
  { id: 'strict-verdict-set', path: 'src/satisfaction-classifier.ts', before: '  for (const t of job.turns) {',
    after: "  if (seen.size !== job.turns.length) throw new Error('SATISFACTION_VERDICT_MISMATCH');\n  for (const t of job.turns) {" },
  { id: 'neutral-recovery', path: 'src/satisfaction-transitions.ts', before: "        if (prev.state === 'neutral') {",
    after: "        if (displeasedFrom !== null) {\n          transitions.push({ kind: 'recovery', fromIndex: displeasedFrom, toIndex: turn.index });\n          displeasedFrom = null;\n        } else if (prev.state === 'neutral') {" },
  { id: 'idless-rollout', path: 'src/rollout-reader.ts', before: "    const id = String(p.id ?? '');",
    after: "    const id = String(p.id ?? (p.call_id ? `call:${p.type}:${p.call_id}` : `anonymous:${events.length}`));" },
];
for (const s of specs) {
  const dir = join(root, 'positive-controls', s.id);
  if (existsSync(join(dir, 'control.json'))) continue;
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'source'), dir, { recursive: true });
  const path = join(dir, s.path), text = readFileSync(path, 'utf8');
  if (!text.includes(s.before)) throw new Error('REFERENCE_FIX_TARGET_NOT_FOUND');
  writeFileSync(path, text.replace(s.before, s.after));
  const hidden = await command(dir, ['test', join(root, 'judge', `${s.id}.test.ts`)], 90000, { TRIAL_WORKSPACE: dir });
  const regressions = await command(dir, ['scripts/test.ts']);
  writeFileSync(join(dir, 'control.json'), JSON.stringify({ hidden, regressions }, null, 2));
  if (hidden.exitCode || regressions.exitCode) throw new Error(`REFERENCE_FIX_FAILED:${s.id}`);
  console.log(`${s.id}: acceptance and original regression suite pass with an isolated reference fix.`);
}
