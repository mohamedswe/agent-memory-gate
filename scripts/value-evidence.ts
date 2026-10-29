/** Export compact local controls; never export credentials or private sessions. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../src/value-trial';
import { tasks } from '../experiments/value-v1-tasks';
const root = resolve('.eval-local/value-v1'), target = resolve('experiments/run-09-data');
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const manifest = load(join(root, 'manifest.json'));
// Preparatory amendments are permitted only before training or comparative
// inference; preserve the initial fingerprints and the frozen random order.
if (process.argv.includes('--seal-preflight')) {
  const calls = readFileSync(join(root, 'inference.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
  if (calls.some(r => r.label !== 'preflight') || existsSync(join(root, 'memory.json'))) throw new Error('CANNOT_AMEND_STARTED_EXPERIMENT');
  manifest.preflightAmendments ??= [];
  const hashes = { harnessHash: hash(readFileSync('src/value-trial.ts')), providerHash: hash(readFileSync('src/eval-provider.ts')), runnerHash: hash(readFileSync('scripts/value-trial.ts')) };
  if (Object.entries(hashes).some(([k,v]) => manifest[k] !== v)) {
    manifest.preflightAmendments.push({ at: new Date().toISOString(), reason: 'Offline integration and fail-closed accounting checks before any training or comparative runs', previous: { harnessHash: manifest.harnessHash, providerHash: manifest.providerHash, runnerHash: manifest.runnerHash } });
    Object.assign(manifest, hashes);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}
const counts = (r: any) => ({ exitCode: r.exitCode, pass: Number(r.stderr.match(/\n\s*(\d+) pass\b/)?.[1] ?? 0), fail: Number(r.stderr.match(/\n\s*(\d+) fail\b/)?.[1] ?? 0), elapsedMs: r.elapsedMs });
const controls = tasks.map(t => {
  const before = load(join(root, 'judge', `${t.id}-before.json`));
  const control = load(join(root, 'positive-controls', t.id, 'control.json'));
  if (!before.exitCode || control.hidden.exitCode || control.regressions.exitCode) throw new Error('INVALID_CONTROL');
  return { task: t.id, before: counts(before), afterReferenceFix: counts(control.hidden), referenceRegressions: counts(control.regressions) };
});
const inference = readFileSync(join(root, 'inference.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
const probe = inference.filter(r => r.label === 'preflight' && typeof r.actualCostUsd === 'number');
const completed = manifest.schedule.filter((r: any) => existsSync(join(root, 'runs', r.key.slice(0, 12), 'judged.json'))).length;
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(target, 'preflight.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
  sourceRegressions: counts(load(join(root, 'preflight-regressions.json'))), controls,
  comparativeRunsExecuted: completed, comparisonStatus: completed === manifest.schedule.length ? 'complete' : completed ? 'incomplete' : 'not_started',
  connectivityProbe: { model: probe.at(-1)?.model ?? null, actualCostUsd: probe.reduce((s,r)=>s+r.actualCostUsd,0), repositoryContentSent: false },
  outstandingNetworkReservationUsd: inference.reduce((s,r)=>s+(r.heldUsd??0),0) }, null, 2) + '\n');
console.log('Exported frozen manifest and local control evidence; no comparative results claimed.');
