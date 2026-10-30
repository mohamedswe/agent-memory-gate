/**
 * Shared, READ-ONLY loading of user sessions for the census and the memory
 * tree: Codex rollouts, Claude Code main-session transcripts, Hermes state.db.
 * Applies the eval-workspace filter. No writes anywhere.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import {
  claudeCodeSessionTurns, codexSessionTurns, hermesSessionTurns, isEvalProject, projectFor,
  type HermesRow, type SessionTurns,
} from '../src/correction-census';
import { resolveSessionProject, type ProjectMap } from '../src/hermes-attribution';

export interface SourceOptions {
  codexRoot: string;
  claudeRoot: string;
  hermesDb: string;
  includeEval: boolean;
}

export interface LoadedSessions {
  sessions: SessionTurns[];
  notes: string[];
  excludedEval: { count: number; byProject: Record<string, number> };
}

/** Defaults from the standard locations, overridable by --codex/--claude/--hermes-db/--include-eval. */
export function sourceOptions(args: string[]): SourceOptions {
  const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const home = homedir();
  return {
    codexRoot: opt('--codex', join(home, '.codex', 'sessions')),
    claudeRoot: opt('--claude', join(home, '.claude', 'projects')),
    hermesDb: opt('--hermes-db', join(home, '.hermes', 'profiles', 'edge', 'state.db')),
    includeEval: args.includes('--include-eval'),
  };
}

/** Recursive *.jsonl walk; skip(dirName) prunes directories. Sorted for determinism. */
function walkJsonl(root: string, skipDir: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!skipDir(e.name)) visit(p); }
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  visit(root);
  return out.sort();
}

export function loadSessions(o: SourceOptions): LoadedSessions {
  const notes: string[] = [];
  const sessions: SessionTurns[] = [];
  const byKey = new Map<string, SessionTurns>();

  /** Merge files that belong to the same logical session (Claude Code resumes). */
  const addSession = (s: SessionTurns) => {
    const key = `${s.source}:${s.sessionId}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, s); sessions.push(s); return; }
    existing.turns.push(...s.turns);
    if (s.startedAt && (!existing.startedAt || s.startedAt < existing.startedAt)) existing.startedAt = s.startedAt;
    if (existing.project === 'unknown') existing.project = s.project;
  };

  // --- Codex
  if (existsSync(o.codexRoot)) {
    const files = walkJsonl(o.codexRoot);
    for (const f of files) {
      try {
        const s = codexSessionTurns(readFileSync(f, 'utf-8'), basename(f, '.jsonl'));
        if (!s.startedAt) s.startedAt = statSync(f).mtimeMs;
        addSession(s);
      } catch (err) { notes.push(`codex: unreadable ${f}: ${(err as Error).message}`); }
    }
    notes.push(`codex: ${files.length} files`);
  } else notes.push(`codex: not found at ${o.codexRoot} (skipped)`);

  // --- Claude Code (main sessions only)
  if (existsSync(o.claudeRoot)) {
    const files = walkJsonl(o.claudeRoot, name => name === 'subagents')
      .filter(f => !basename(f).startsWith('agent-') && basename(f) !== 'history.jsonl');
    for (const f of files) {
      try {
        const s = claudeCodeSessionTurns(readFileSync(f, 'utf-8'), basename(f, '.jsonl'));
        if (!s.startedAt) s.startedAt = statSync(f).mtimeMs;
        if (s.turns.length) addSession(s);
      } catch (err) { notes.push(`claude-code: unreadable ${f}: ${(err as Error).message}`); }
    }
    notes.push(`claude-code: ${files.length} main-session files`);
  } else notes.push(`claude-code: not found at ${o.claudeRoot} (skipped)`);

  // --- Hermes (readonly)
  if (existsSync(o.hermesDb)) {
    const mapPath = join('live-run', 'hermes-project-map.json');
    let projectMap: ProjectMap = null;
    if (existsSync(mapPath)) { try { projectMap = JSON.parse(readFileSync(mapPath, 'utf-8')); } catch { projectMap = null; } }
    const db = new Database(o.hermesDb, { readonly: true });
    try {
      const rows = db.query('SELECT s.id AS sid, s.cwd AS cwd, s.started_at AS started_at, m.id AS id, m.role AS role, m.content AS content FROM sessions s JOIN messages m ON m.session_id = s.id ORDER BY s.id, m.id').all() as
        Array<{ sid: string; cwd: string | null; started_at: unknown; id: number; role: string; content: string | null }>;
      const bySession = new Map<string, { cwd: string | null; startedAt: unknown; rows: HermesRow[] }>();
      for (const r of rows) {
        const entry = bySession.get(r.sid) ?? { cwd: r.cwd, startedAt: r.started_at, rows: [] };
        entry.rows.push({ id: r.id, role: r.role, content: typeof r.content === 'string' ? r.content : r.content == null ? null : String(r.content) });
        bySession.set(r.sid, entry);
      }
      for (const [sid, e] of bySession) {
        const dir = resolveSessionProject(projectMap, `hermes:${sid}`, e.cwd);
        addSession(hermesSessionTurns(sid, projectFor(dir), e.startedAt, e.rows));
      }
      notes.push(`hermes: ${bySession.size} sessions${projectMap ? ' (project map loaded)' : ''}`);
    } finally { db.close(); }
  } else notes.push(`hermes: not found at ${o.hermesDb} (skipped)`);

  // --- Eval-workspace filter
  const byProject: Record<string, number> = {};
  const kept = o.includeEval ? sessions : sessions.filter(s => {
    if (!isEvalProject(s.project)) return true;
    byProject[s.project] = (byProject[s.project] ?? 0) + 1;
    return false;
  });
  const count = sessions.length - kept.length;
  notes.push(o.includeEval ? 'eval workspaces: included (--include-eval)' : `eval workspaces: excluded ${count} sessions`);
  return { sessions: kept, notes, excludedEval: { count, byProject } };
}
