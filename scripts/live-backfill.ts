/**
 * LIVE full backfill — processes ALL redacted candidates through the paid
 * reviewer into the DISPOSABLE brain (live-run/brain.pglite). Authorized by
 * Mohamed, 2026-10-08. Sequential; stops at budget refusal.
 *
 * Usage: bun scripts/live-backfill.ts [limit]
 */
import { callReviewer } from '../src/reviewer-client';
import { redactCandidates, Candidate } from '../src/redaction-gate';
import { writeCandidateRecord } from '../src/candidate-writer';
import { BudgetLedger } from '../src/budget-ledger';
import { RecordService } from '../src/records';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT_DIR = 'live-run';
const LIMIT = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
mkdirSync(OUT_DIR, { recursive: true });

// --- auth ---
const auth = JSON.parse(readFileSync(join(homedir(), '.hermes', 'profiles', 'edge', 'auth.json'), 'utf-8'));
const nous = auth.providers.nous;
const TOKEN = nous.access_token;
const BASE = nous.inference_base_url;

// --- candidates ---
const all: Candidate[] = readFileSync('candidate-review/candidates.jsonl', 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l) as Candidate);
const redacted = redactCandidates(all);
const batch = LIMIT ? redacted.passed.slice(0, LIMIT) : redacted.passed;
console.log(`backfill: ${batch.length} candidates (of ${redacted.passed.length} redacted-passed, ${all.length} total)`);

// --- budget ---
const ledger = await BudgetLedger.open(join(OUT_DIR, 'ledger.db'), { monthlyCapUsd: 10 });

// --- disposable brain (fresh for this backfill) ---
const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const { configureGateway } = await import('file://' + join(vendor, 'src/core/ai/gateway.ts').replace(/\\/g, '/'));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import('file://' + join(vendor, 'src/core/pglite-engine.ts').replace(/\\/g, '/'));
const brainPath = join(OUT_DIR, 'brain.pglite');
if (existsSync(brainPath)) rmSync(brainPath, { recursive: true, force: true });
const engine = new PGLiteEngine();
await engine.connect({ database_path: brainPath });
await engine.initSchema();
const service = new RecordService('codex', engine);

const results: { key: string; status: string; kind?: string; error?: string }[] = [];
let saved = 0, skipped = 0, failed = 0;

for (let i = 0; i < batch.length; i++) {
  const candidate = batch[i];
  const runKey = `backfill-${Date.now()}-${i}`;
  try {
    const output = await callReviewer(runKey, candidate, {
      httpPost: async (url, body) => {
        const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(body as object), model: 'z-ai/glm-5.3', max_tokens: 1600 }),
        });
        return { ok: res.ok, json: await res.json() };
      },
      budget: ledger,
      estimateUsd: () => 0.05,
      endpointUrl: BASE + '/chat/completions',
      model: 'z-ai/glm-5.3',
    });

    if (output.content === 'NOT_WORTH_SAVING') {
      skipped++;
      results.push({ key: candidate.key.slice(0, 60), status: 'not_worth_saving' });
    } else {
      const record = await writeCandidateRecord(service, 'codex', candidate, output);
      saved++;
      results.push({ key: candidate.key.slice(0, 60), status: 'saved', kind: record.kind });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failed++;
    results.push({ key: candidate.key.slice(0, 60), status: 'failed', error: msg.slice(0, 120) });
    if (msg.includes('BUDGET_REFUSED')) {
      console.log(`budget refused at candidate ${i} — stopping.`);
      break;
    }
    // transient errors: continue to next candidate
  }
  if ((i + 1) % 25 === 0) {
    console.log(`progress: ${i + 1}/${batch.length} | saved=${saved} skipped=${skipped} failed=${failed} | remaining=$${ledger.remainingUsd().toFixed(4)}`);
  }
}

console.log(`\nDONE: saved=${saved} skipped=${skipped} failed=${failed}`);
console.log(`budget remaining: $${ledger.remainingUsd().toFixed(6)}`);
// Per-candidate outcome log (kept in live-run/, gitignored):
writeFileSync(join(OUT_DIR, 'backfill-results.jsonl'),
  results.map(r => JSON.stringify(r)).join('\n') + '\n');
for (const r of results.filter(x => x.status !== 'saved')) {
  console.log(`  ${r.status}: ${r.key} ${r.error ? '-> ' + r.error : ''}`);
}
await ledger.close();
await engine.disconnect();
