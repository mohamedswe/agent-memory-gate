/**
 * LIVE one-candidate pipeline run — the first paid call of the dual-brain
 * memory system. Authorized by Mohamed ("go live", 2026-10-08).
 *
 * Reads auth from Hermes's auth.json (never printed, never committed).
 * Writes ONLY to: live-run/ledger.db (budget) + live-run/brain.pglite
 * (disposable brain). Everything else is read-only.
 *
 * Usage: bun scripts/live-one.ts <candidate-index or skip to pick first non-wait>
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
mkdirSync(OUT_DIR, { recursive: true });

// --- auth (read-only, never logged) ---
const authPath = join(homedir(), '.hermes', 'profiles', 'edge', 'auth.json');
const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
const nous = auth.providers.nous;
const TOKEN = nous.access_token;
const BASE = nous.inference_base_url;
if (!TOKEN || !BASE) { console.error('missing nous auth'); process.exit(1); }

// --- pick one real candidate from the review export ---
const all: Candidate[] = readFileSync('candidate-review/candidates.jsonl', 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l) as Candidate);
const redacted = redactCandidates(all);
// pick a meaty procedure candidate: exec tool, high rediscoveries
const pick = redacted.passed.find(c => c.key.startsWith('tool:exec') && c.counts.agentRediscoveries >= 3)
  ?? redacted.passed[0];
console.log('candidate picked:', JSON.stringify({ key: pick.key.slice(0, 80), counts: pick.counts }));
console.log(`redaction: ${redacted.passed.length} passed, ${redacted.excluded.length} excluded of ${all.length}`);

// --- budget ledger: $10 cap, real file ---
const ledger = await BudgetLedger.open(join(OUT_DIR, 'ledger.db'), { monthlyCapUsd: 10 });

// --- disposable brain ---
const vendor = process.env.GBRAIN_PACKAGE_DIR
  ?? join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
for (const key of Object.keys(process.env)) {
  if (/^(GBRAIN_|DATABASE_URL$|PGHOST$)/.test(key) && key !== 'GBRAIN_PACKAGE_DIR') delete process.env[key];
}
const { configureGateway } = await import('file://' + join(vendor, 'src/core/ai/gateway.ts').replace(/\\/g, '/'));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import('file://' + join(vendor, 'src/core/pglite-engine.ts').replace(/\\/g, '/'));
const brainPath = join(OUT_DIR, 'brain.pglite');
if (existsSync(brainPath)) rmSync(brainPath, { force: true });
const engine = new PGLiteEngine();
await engine.connect({ database_path: brainPath });
await engine.initSchema();
const service = new RecordService('codex', engine);

// --- conservative estimate from observed prices ($0.91/M in, $2.86/M out) ---
// prompt ~600 tokens in + 300 out bounded => ~0.0025; reserve 10x margin
const ESTIMATE_USD = 0.05;

const runKey = `live-one-${Date.now()}`;
console.log('budget remaining before:', ledger.remainingUsd());

try {
  const output = await callReviewer(runKey, pick, {
    httpPost: async (url, body) => {
      const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(body as object), model: 'z-ai/glm-5.3', max_tokens: 400 }),
      });
      return { ok: res.ok, json: await res.json() };
    },
    budget: ledger,
    estimateUsd: () => ESTIMATE_USD,
    endpointUrl: BASE + '/chat/completions',
    model: 'z-ai/glm-5.3',
  });

  console.log('reviewer output:', JSON.stringify(output, null, 2));

  if (output.content === 'NOT_WORTH_SAVING') {
    console.log('reviewer said NOT_WORTH_SAVING — no record written.');
  } else {
    const record = await writeCandidateRecord(service, 'codex', pick, output);
    console.log('record created in disposable brain:', JSON.stringify({
      id: record.id, kind: record.kind, lifecycle: record.lifecycle,
      evidence: record.evidence, content: record.content,
    }, null, 2));
    const readBack = await service.read('codex', record.id);
    console.log('read-back from brain ok:', readBack !== null);
  }
} finally {
  console.log('budget remaining after:', ledger.remainingUsd());
  await ledger.close();
  await engine.disconnect();
}

// Human-readable run log (no token, no full session text)
writeFileSync(join(OUT_DIR, 'live-one-result.md'), [
  `# Live one-candidate run — ${new Date().toISOString()}`,
  '',
  `- Candidate: \`${pick.key.slice(0, 100)}\``,
  `- Counts: ${JSON.stringify(pick.counts)}`,
  `- Redaction: ${redacted.passed.length} passed / ${redacted.excluded.length} excluded`,
  `- Budget before: $10.00 | after: see ledger`,
  '',
  'See console output for reviewer JSON and record id.',
].join('\n'));
