/**
 * hermes-capture.ts — queue satisfaction-trajectory jobs from the Hermes
 * session store (state.db) into the capture queue. Deterministic, free.
 *
 * Reads user messages per session from the Hermes profile's state.db, builds
 * one satisfaction job per session that has real user turns, appends them to
 * the queue. NO classification here — that is the paid step in queue-review.
 *
 * Cursor: Hermes sessions are keyed by session id (stable), so a processed
 * marker lives in live-run/hermes-capture-cursor.json. Only sessions not yet
 * marked (or with a newer max message id) are captured — session growth is
 * detected by the last message id.
 *
 * Usage:
 *   bun scripts/hermes-capture.ts [--db <path>] [--queue <file>] [--session <id>] [--dry-run]
 *
 * --session <id>: capture only that one session (accepts prefix match).
 */
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { extractHermesTrajectory, type HermesMessageRow } from '../src/hermes-adapter';
import { resolveSessionProject, type ProjectMap } from '../src/hermes-attribution';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, fallback: string): string => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const dbPath = opt('--db', join(homedir(), '.hermes', 'profiles', 'edge', 'state.db'));
const queuePath = opt('--queue', join('live-run', 'capture-queue.jsonl'));
const onlySession = flag('--session') ? args[args.indexOf('--session') + 1] : null;
const DRY = flag('--dry-run');

// Operator-curated attribution: session-id prefix -> project dir. Lives in
// live-run/hermes-project-map.json. cwd always wins; unmapped stays unknown.
const MAP_PATH = join('live-run', 'hermes-project-map.json');
const projectMap: ProjectMap = existsSync(MAP_PATH)
  ? (() => { try { return JSON.parse(readFileSync(MAP_PATH, 'utf-8')); } catch { return null; } })()
  : null;

const CURSOR_PATH = join('live-run', 'hermes-capture-cursor.json');
interface CursorState { version: 1; processed: Record<string, number> } // session id -> last message id captured
const cursor: CursorState = existsSync(CURSOR_PATH)
  ? (() => { try { const c = JSON.parse(readFileSync(CURSOR_PATH, 'utf-8')) as CursorState; if (c.version === 1 && c.processed) return c; } catch { /* fresh */ } return { version: 1, processed: {} }; })()
  : { version: 1, processed: {} };

const db = new Database(dbPath, { readonly: true });

// sessions ordered by recency; capture session cwd/title metadata too
const sessionFilter = onlySession ? `WHERE s.id LIKE '%${onlySession}%'` : '';
const sessions = db.query(`
  SELECT s.id, s.cwd, s.title, COALESCE(MAX(m.id), 0) AS max_msg_id
  FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
  ${sessionFilter}
  GROUP BY s.id ORDER BY s.started_at DESC
`).all() as Array<{ id: string; cwd: string | null; title: string | null; max_msg_id: number }>;

let captured = 0, skippedUnchanged = 0, quiet = 0, jobsQueued = 0;

for (const s of sessions) {
  const lastCaptured = cursor.processed[s.id] ?? -1;
  if (s.max_msg_id <= lastCaptured) { skippedUnchanged++; continue; }

  const rows = db.query(`
    SELECT id, role, content, timestamp FROM messages
    WHERE session_id = ? AND id > ? ORDER BY id
  `).all(s.id, lastCaptured) as HermesMessageRow[];

  const trajectory = extractHermesTrajectory(rows);
  if (trajectory.turns.length === 0) { quiet++; continue; }

  const job = {
    queuedAt: new Date().toISOString(),
    job: 'satisfaction-trajectory' as const,
    sessionFile: `hermes:${s.id}`,
    projectDir: resolveSessionProject(projectMap, `hermes:${s.id}`, s.cwd) ?? 'unknown',
    branch: null,
    turns: trajectory.turns,
  };
  captured++;
  jobsQueued++;
  if (!DRY) {
    mkdirSync(dirname(queuePath), { recursive: true });
    appendFileSync(queuePath, JSON.stringify(job) + '\n');
    cursor.processed[s.id] = s.max_msg_id;
  }
  if (DRY) console.log(`[dry] ${s.id} (${s.title?.slice(0, 40) ?? 'untitled'}): ${trajectory.turns.length} turns, cwd=${s.cwd ?? '?'}`);
}

db.close();
if (!DRY) {
  mkdirSync(dirname(CURSOR_PATH), { recursive: true });
  writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2) + '\n');
}
console.log(JSON.stringify({
  sessionsSeen: sessions.length, sessionsWithNewMessages: captured,
  quietNoUserTurns: quiet, jobsQueued, skippedUnchanged,
  queue: DRY ? '(dry-run: not written)' : queuePath,
}, null, 2));