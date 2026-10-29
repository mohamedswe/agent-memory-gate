/**
 * session-capture.ts — the incremental session-end capture lane (deterministic
 * only; NO reviewer calls, NO brain writes by default).
 *
 * Walks ~/.codex/sessions for rollout JSONLs not yet processed (by cursor
 * identity: path+mtime+size), extracts redacted promotion candidates via
 * src/session-capture.ts, appends them to the capture queue
 * (live-run/capture-queue.jsonl), and advances the durable cursor.
 *
 * Lane 2 (2026-10-11): every session with user turns also queues ONE
 * satisfaction-trajectory job (user message sequence only) for the batched
 * paid classifier in queue-review. Deterministic here; sentiment is paid.
 *
 * Lane 1b (2026-10-12): cross-session repetition. Every session's raw keys
 * are observed into the project-scoped cross-session ledger; keys that now
 * appear in >= 2 DISTINCT sessions of the same project (and were never
 * promoted) are queued as candidates with cross-session provenance — the
 * "every session in this project starts with this command" signature.
 *
 * Usage:
 *   bun scripts/session-capture.ts [--sessions <dir>] [--queue <file>] [--dry-run]
 *   bun scripts/session-capture.ts --baseline [iso-date]   (adopt corpus, no queuing)
 *
 * --dry-run: report what would be captured without writing queue or cursor.
 */
import { readdirSync, statSync, existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { CaptureCursor, cursorPath } from '../src/capture-cursor';
import { captureSession } from '../src/session-capture';
import { extractUserTurns, buildSatisfactionJob } from '../src/session-trajectory';
import { CrossSessionLedger } from '../src/cross-session-ledger';
import { redactCandidates } from '../src/redaction-gate';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const sessionsRoot = opt('--sessions', join(homedir(), '.codex', 'sessions'));
const queuePath = opt('--queue', join('live-run', 'capture-queue.jsonl'));
const dryRun = flag('--dry-run');
// --baseline [iso-date]: adopt the cursor onto an ALREADY-REVIEWED corpus.
const baselineIdx = args.indexOf('--baseline');
const baseline = baselineIdx >= 0;
const baselineCutoff = baseline && args[baselineIdx + 1] && !args[baselineIdx + 1].startsWith('--') ? Date.parse(args[baselineIdx + 1]) : null;

interface JsonQueueLine {
  queuedAt: string;
  sessionFile: string;
  projectDir: string;
  key: string;
  counts: { userRepeats: number; agentRediscoveries: number; rawMentions: number };
  sourceKeys?: string[];
  sourceSessions?: string[];
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

const storeDir = dirname(queuePath);
const cursor = new CaptureCursor(cursorPath(storeDir));
const crossSession = new CrossSessionLedger(join(storeDir, 'cross-session-ledger.json'),{persist:!dryRun});

const files = walkJsonl(sessionsRoot);
let newFiles = 0, quietFiles = 0;
let queued = 0, excluded = 0, jobs = 0, crossQueued = 0;

if (!dryRun) mkdirSync(storeDir, { recursive: true });

if (baseline) {
  let adopted = 0, skipped = 0;
  for (const f of files) {
    if (baselineCutoff !== null && !isNaN(baselineCutoff)) {
      const m = statSync(f).mtimeMs;
      if (m > baselineCutoff) { skipped++; continue; }
    }
    if (!cursor.isProcessed(f)) {
      if (!dryRun) { cursor.markProcessed(f); }
      adopted++;
    }
  }
  console.log(JSON.stringify({ mode: dryRun ? 'baseline-adopt (dry)' : 'baseline-adopt', adopted, skippedNewerThanCutoff: skipped, cutoff: baselineCutoff === null ? null : new Date(baselineCutoff).toISOString() }, null, 2));
  process.exit(0);
}

for (const f of files) {
  if (cursor.isProcessed(f)) continue;
  const result = captureSession(f);
  // Lane 2: satisfaction-trajectory job — one per session with user turns.
  const trajectory = extractUserTurns(readFileSync(f, 'utf-8'));
  const satisfactionJob = buildSatisfactionJob(f, trajectory);
  const hasJob = satisfactionJob !== null;

  // Lane 1b: cross-session observation — EVERY raw key this session saw,
  // observed into the project ledger (idempotent per session).
  const projectDir = result.projectDir;
  if (projectDir) {
    for (const observation of result.observedKeys) crossSession.observe(projectDir, observation.key, f, observation.sourceKeys);
  }
  // keys that NOW cross the threshold (>=2 distinct sessions, same project,
  // not yet promoted) become candidates with cross-session provenance
  let crossing: string[] = [];
  if (projectDir) crossing = crossSession.newlyCrossing(projectDir);
  const crossCandidates = crossing.length > 0
    ? redactCandidates(crossing.map(key => ({
        sessionFile: f,
        projectDir,
        key,
        sourceKeys: [...new Set(crossSession.sourcesFor(projectDir,key).flatMap(s=>s.sourceKeys))],
        sourceSessions: crossSession.sourcesFor(projectDir,key).map(s=>s.sessionFile),
        counts: {
          userRepeats: 0,
          agentRediscoveries: 0,
          rawMentions: crossSession.sessionCount(projectDir, key),
        },
      })))
    : { passed: [], excluded: [] };

  if (result.queued.length === 0 && result.excluded.length === 0 && !hasJob && crossCandidates.passed.length === 0) quietFiles++;
  else newFiles++;
  queued += result.queued.length;
  excluded += result.excluded.length + crossCandidates.excluded.length;
  jobs += hasJob ? 1 : 0;
  crossQueued += crossCandidates.passed.length;

  if (!dryRun) {
    if (satisfactionJob) {
      const jobLine = { queuedAt: new Date().toISOString(), ...satisfactionJob };
      appendFileSync(queuePath, JSON.stringify(jobLine) + '\n');
    }
    for (const c of result.queued) {
      const line: JsonQueueLine = {
        queuedAt: new Date().toISOString(),
        sessionFile: c.sessionFile,
        projectDir: c.projectDir,
        key: c.key,
        counts: c.counts,
        ...(c.sourceKeys?{sourceKeys:c.sourceKeys}:{}),
      };
      appendFileSync(queuePath, JSON.stringify(line) + '\n');
    }
    // cross-session candidates: distinct provenance, then mark promoted
    // (never re-queued — the start command appears every session forever)
    for (const c of crossCandidates.passed) {
      appendFileSync(queuePath, JSON.stringify({
        queuedAt: new Date().toISOString(),
        sessionFile: c.sessionFile,
        projectDir: c.projectDir,
        key: c.key,
        counts: c.counts,
        sourceKeys:c.sourceKeys,
        sourceSessions:c.sourceSessions,
        crossSession: true,
      }) + '\n');
      crossSession.markPromoted(c.projectDir, c.key);
    }
    for (const x of [...result.excluded,...crossCandidates.excluded]) {
      appendFileSync(queuePath, JSON.stringify({
        queuedAt: new Date().toISOString(),
        sessionFile: x.candidate.sessionFile,
        projectDir: x.candidate.projectDir,
        key: x.candidate.key,
        counts: x.candidate.counts,
        sourceKeys:x.candidate.sourceKeys,
        excluded: x.reason,
      }) + '\n');
    }
    cursor.markProcessed(f);
  }
  if(dryRun)for(const c of crossCandidates.passed)crossSession.markPromoted(c.projectDir,c.key);
  if (dryRun) console.log(`[dry] ${f}: queued=${result.queued.length} excluded=${result.excluded.length} crossQueued=${crossCandidates.passed.length} satisfactionJob=${hasJob ? 'yes' : 'no'} project=${result.projectDir}`);
}

const summary = { sessionsTotal: files.length, sessionsNew: newFiles, quiet: quietFiles, queued, excluded, crossSessionQueued: crossQueued, satisfactionJobs: jobs, queue: dryRun ? '(dry-run: not written)' : queuePath, cursor: dryRun ? '(dry-run: not advanced)' : cursorPath(storeDir), crossSessionLedger: dryRun ? '(dry-run: not written)' : join(storeDir, 'cross-session-ledger.json') };
console.log(JSON.stringify(summary, null, 2));
if (dryRun) console.log('dry-run: nothing written');
