/**
 * queue-review.ts — push the capture queue through the paid stages into the
 * DISPOSABLE brain (live-run/brain.pglite). Authorized per-run by Mohamed.
 *
 * Two job types share one pass:
 *  - repetition candidates: reviewer -> (NOT_WORTH_SAVING | record)
 *  - satisfaction-trajectory jobs: batched classifier -> per-turn verdicts ->
 *    deterministic arc detection -> arc findings recorded as attempt records
 *    (resolved arcs only; unresolved arcs recorded with outcome unresolved).
 *
 * Reads live-run/capture-queue.jsonl lines that have no `excluded` marker and
 * no `reviewed` marker yet. Reserves+reconciles budget per call. Marks each
 * processed line with its outcome so re-runs skip it. NEVER wipes the brain.
 * Throttled 1.5s between calls.
 *
 * Usage:
 *   bun scripts/queue-review.ts [--limit N] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { callReviewer } from '../src/reviewer-client';
import { writeCandidateRecord } from '../src/candidate-writer';
import { BudgetLedger } from '../src/budget-ledger';
import { RecordService } from '../src/records';
import { classifySatisfaction } from '../src/satisfaction-classifier';
import { detectTransitions } from '../src/satisfaction-transitions';
import { renderMarkerRecord } from '../src/marker-records';
import type { UserTurn } from '../src/session-trajectory';
import type { Candidate } from '../src/redaction-gate';
import type { SatisfactionJob, UserTurn } from '../src/session-trajectory';

const OUT_DIR = 'live-run';
const REVIEW_PATH = join(OUT_DIR, 'queue-review-report.jsonl');
const SATISFACTION_PATH = join(OUT_DIR, 'satisfaction-verdicts.jsonl');
mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string): number | undefined => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : undefined; };
const LIMIT = opt('--limit');
const DRY = flag('--dry-run');
const queueArg = args.indexOf('--queue');
const queueFile = queueArg >= 0 && args[queueArg + 1] ? args[queueArg + 1] : join(OUT_DIR, 'capture-queue.jsonl');
const QUEUE_PATH = queueFile;

// --- auth ---
const auth = JSON.parse(readFileSync(join(homedir(), '.hermes', 'profiles', 'edge', 'auth.json'), 'utf-8'));
const TOKEN = auth.providers.nous.access_token;
const BASE = auth.providers.nous.inference_base_url;
if (!TOKEN || !BASE) { console.error('missing nous auth'); process.exit(1); }

// --- queue lines ---
interface QueueLine {
  queuedAt: string; sessionFile: string; projectDir: string;
  key?: string;
  counts?: { userRepeats: number; agentRediscoveries: number; rawMentions: number };
  turns?: UserTurn[];
  job?: 'satisfaction-trajectory';
  excluded?: string;
  reviewed?: { status: string; at: string };
}
const queue: QueueLine[] = existsSync(QUEUE_PATH)
  ? readFileSync(QUEUE_PATH, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as QueueLine)
  : [];
const pending = queue.filter(l => !l.excluded && !l.reviewed).slice(0, LIMIT ?? Infinity);
console.log(JSON.stringify({
  queueTotal: queue.length, pendingReview: pending.length,
  repetitionCandidates: pending.filter(l => !l.job).length,
  satisfactionJobs: pending.filter(l => l.job === 'satisfaction-trajectory').length,
  limit: LIMIT ?? null, dryRun: DRY,
}, null, 2));
if (DRY) {
  for (const l of pending) {
    const label = l.job === 'satisfaction-trajectory'
      ? `satisfaction job, ${l.turns?.length ?? 0} turns`
      : `candidate: ${String(l.key).slice(0, 70)}`;
    console.log(`[dry] ${l.sessionFile.slice(0, 40)} | ${label}`);
  }
  process.exit(0);
}
if (pending.length === 0) { console.log('nothing pending; queue is fully reviewed or empty'); process.exit(0); }

// --- budget ---
const ledger = await BudgetLedger.open(join(OUT_DIR, 'ledger.db'), { monthlyCapUsd: 10 });

// --- disposable brain (NO wipe) ---
const vendor = process.env.GBRAIN_PACKAGE_DIR ?? join(homedir(), '.bun', 'install', 'global', 'node_modules', 'gbrain');
for (const key of Object.keys(process.env)) {
  if (/^(GBRAIN_|DATABASE_URL$|PGHOST$)/.test(key) && key !== 'GBRAIN_PACKAGE_DIR') delete process.env[key];
}
const fwd = (p: string) => 'file://' + p.replace(/\\/g, '/');
const { configureGateway } = await import(fwd(join(vendor, 'src/core/ai/gateway.ts')));
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const { PGLiteEngine } = await import(fwd(join(vendor, 'src/core/pglite-engine.ts')));
const engine = new PGLiteEngine();
await engine.connect({ database_path: join(OUT_DIR, 'brain.pglite') });
await engine.initSchema();
const service = new RecordService('codex', engine);

const ESTIMATE_USD = 0.05;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const report: unknown[] = [];
const verdictLines: unknown[] = [];
let saved = 0, notWorth = 0, failed = 0, jobsDone = 0, arcsFound = 0;

const httpPost = async (url: string, body: unknown) => {
  const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body as object), model: 'z-ai/glm-5.3', max_tokens: 1600 }),
  });
  return { ok: res.ok, json: await res.json() };
};

try {
  console.log('budget remaining before:', ledger.remainingUsd());
  for (const line of pending) {
    const runKey = `queue-review-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let outcome: { status: string; detail?: unknown };

    if (line.job === 'satisfaction-trajectory') {
      // --- lane 2: batched satisfaction classification ---
      const job: SatisfactionJob = {
        job: 'satisfaction-trajectory',
        sessionFile: line.sessionFile,
        projectDir: line.projectDir,
        branch: null,
        turns: line.turns ?? [],
      };
      try {
        const result = await classifySatisfaction(runKey, job, {
          httpPost: async (url, body) => {
            const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...(body as object), model: 'z-ai/glm-5.3', max_tokens: 6000 }),
            });
            return { ok: res.ok, json: await res.json() };
          },
          budget: ledger,
          estimateUsd: () => ESTIMATE_USD,
          endpointUrl: BASE + '/chat/completions',
          model: 'z-ai/glm-5.3',
        });
        jobsDone++;
        const transitions = detectTransitions(result.turns);
        // Marker records: one per transition, written via the normal writer
        // (deterministic content from the user's own turns; reviewer contract shape).
        const turnTexts: UserTurn[] = (line.turns ?? []).map((t, i) => ({ index: i, id: t.id ?? String(i), text: t.text ?? '' }));
        const markerOutcomes: unknown[] = [];
        for (const tr of transitions) {
          const marker = renderMarkerRecord({
            sessionFile: line.sessionFile,
            projectDir: line.projectDir,
            transition: tr,
            turns: turnTexts,
          });
          // writeCandidateRecord expects a Candidate for provenance; marker
          // records use the transition as their provenance key.
          const pseudoCandidate = {
            sessionFile: line.sessionFile,
            projectDir: line.projectDir,
            key: `satisfaction:${tr.kind}:${tr.fromIndex}-${tr.toIndex}`,
            counts: { userRepeats: 0, agentRediscoveries: 0, rawMentions: 0 },
          };
          const record = await writeCandidateRecord(service, 'codex', pseudoCandidate, marker);
          markerOutcomes.push({ kind: tr.kind, recordId: record.id });
          saved++;
        }
        arcsFound += transitions.length;
        verdictLines.push({ sessionFile: line.sessionFile, projectDir: line.projectDir, verdicts: result.turns, transitions, records: markerOutcomes, costUsd: result.costUsd });
        outcome = { status: 'classified', turns: result.turns.length, transitions: transitions.length, records: markerOutcomes.length };
      } catch (e) {
        failed++;
        outcome = { status: 'failed', error: String(e).slice(0, 200) };
      }
    } else {
      // --- lane 1: repetition candidate review ---
      const candidate: Candidate = { sessionFile: line.sessionFile, projectDir: line.projectDir, key: line.key ?? '', counts: line.counts ?? { userRepeats: 0, agentRediscoveries: 0, rawMentions: 0 } };
      try {
        const output = await callReviewer(runKey, candidate, {
          httpPost,
          budget: ledger,
          estimateUsd: () => ESTIMATE_USD,
          endpointUrl: BASE + '/chat/completions',
          model: 'z-ai/glm-5.3',
        });
        if (output.content === 'NOT_WORTH_SAVING') {
          notWorth++;
          outcome = { status: 'not_worth_saving' };
        } else {
          const record = await writeCandidateRecord(service, 'codex', candidate, output);
          saved++;
          outcome = { status: 'saved', recordId: record.id, kind: record.kind, content: record.content };
        }
      } catch (e) {
        failed++;
        outcome = { status: 'failed', error: String(e).slice(0, 200) };
      }
    }

    line.reviewed = { status: outcome.status, at: new Date().toISOString() };
    report.push({ sessionFile: line.sessionFile, key: line.key?.slice(0, 100) ?? '(satisfaction)', ...outcome });
    console.log(`${outcome.status}: ${line.key?.slice(0, 60) ?? line.sessionFile.slice(0, 60)}`);
    await sleep(1500); // throttle: respect per-minute rate limits
  }
} finally {
  console.log('budget remaining after:', ledger.remainingUsd());
  await ledger.close();
  await engine.disconnect();
}

// persist reviewed markers + report + verdicts
writeFileSync(QUEUE_PATH, queue.map(l => JSON.stringify(l)).join('\n') + '\n');
const prevReport: unknown[] = existsSync(REVIEW_PATH)
  ? readFileSync(REVIEW_PATH, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
writeFileSync(REVIEW_PATH, [...prevReport, ...report].map(r => JSON.stringify(r)).join('\n') + '\n');
const prevVerdicts: unknown[] = existsSync(SATISFACTION_PATH)
  ? readFileSync(SATISFACTION_PATH, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];
writeFileSync(SATISFACTION_PATH, [...prevVerdicts, ...verdictLines].map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ saved, notWorthSaving: notWorth, satisfactionJobs: jobsDone, arcsFound, failed }, null, 2));