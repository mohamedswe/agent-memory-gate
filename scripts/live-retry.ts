/**
 * LIVE retry pass — re-runs ONLY the candidates that failed in the last
 * backfill (from live-run/backfill-results.jsonl) against the EXISTING
 * disposable brain. Uses the reasoning_content fallback + larger max_tokens.
 * Authorized under the standing paid-call authorization (2026-10-08).
 *
 * Usage: bun scripts/live-retry.ts
 */
import { callReviewer } from '../src/reviewer-client';
import type { Candidate } from '../src/redaction-gate';
import { writeCandidateRecord } from '../src/candidate-writer';
import { BudgetLedger } from '../src/budget-ledger';
import { RecordService } from '../src/records';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT_DIR = 'live-run';
const auth = JSON.parse(readFileSync(join(homedir(), '.hermes', 'profiles', 'edge', 'auth.json'), 'utf-8'));
const TOKEN = auth.providers.nous.access_token;
const BASE = auth.providers.nous.inference_base_url;

// Load all candidates, keep only the failed ones (match by key prefix):
const all: Candidate[] = readFileSync('candidate-review/candidates.jsonl', 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l) as Candidate);
const prior = readFileSync(join(OUT_DIR, 'backfill-results.jsonl'), 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l) as { key: string; status: string });
const failedKeys = new Set(prior.filter(r => r.status === 'failed').map(r => r.key));
const toRetry = all.filter(c => failedKeys.has(c.key.slice(0, 60)));
console.log(`retry: ${toRetry.length} failed candidates (of ${all.length} total)`);

const ledger = await BudgetLedger.open(join(OUT_DIR, 'ledger.db'), { monthlyCapUsd: 10 });
console.log('budget remaining before:', ledger.remainingUsd().toFixed(4));

// EXISTING brain — no wipe:
const vendor = join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
const fwd = (p: string) => 'file://' + p.split(String.fromCharCode(92)).join('/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));
const engine = new PGLiteEngine();
await engine.connect({ database_path: join(OUT_DIR, 'brain.pglite') });
await engine.initSchema();
const service = new RecordService('codex', engine);

const results: { key: string; status: string; kind?: string; error?: string }[] = [];
let saved = 0, skipped = 0, failed = 0;

for (let i = 0; i < toRetry.length; i++) {
  const candidate = toRetry[i];
  const runKey = `retry-${Date.now()}-${i}`;
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
    if (msg.includes('BUDGET_REFUSED')) { console.log('budget refused — stopping.'); break; }
  }
  if ((i + 1) % 25 === 0) {
    console.log(`progress: ${i + 1}/${toRetry.length} | saved=${saved} skipped=${skipped} failed=${failed} | remaining=$${ledger.remainingUsd().toFixed(4)}`);
  }
}

console.log(`\nRETRY DONE: saved=${saved} skipped=${skipped} failed=${failed}`);
console.log(`budget remaining after: $${ledger.remainingUsd().toFixed(4)}`);
writeFileSync(join(OUT_DIR, 'retry-results.jsonl'), results.map(r => JSON.stringify(r)).join('\n') + '\n');
await ledger.close();
await engine.disconnect();
