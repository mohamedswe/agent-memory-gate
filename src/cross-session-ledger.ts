/**
 * Cross-session ledger — the project-scoped repetition gate, phase 2.
 *
 * The within-session usage ledger (src/usage-ledger.ts) promotes on >=2
 * repeats INSIDE one session. This ledger answers the other question: does
 * this key appear once in MANY sessions of the SAME project? That pattern —
 * "every session in emara starts with this command" — is the textbook
 * signature of a durable procedure, and the within-session gate structurally
 * cannot see it (once per session = never >=2 in one session).
 *
 * Design decisions (all test-pinned):
 *  - Count DISTINCT SESSIONS (a session set per key), not raw mentions.
 *  - Scope by project: a key repeating across different projects is a
 *    generic habit, not project knowledge, and does not bleed between scopes.
 *  - Once promoted, never re-queued: the start command appears every session
 *    forever; without a promoted-set it would be re-queued and re-paid forever.
 *  - Durable JSON state, corrupt file falls back to fresh (fail-open to
 *    re-observe — never silently skip).
 *
 * Deterministic only: no inference, no network, no brain. The reviewer stays
 * the paid gate; this just decides what gets to stand in front of it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface LedgerState {
  version: 1;
  /** project -> key -> sorted list of distinct session files */
  sessions: Record<string, Record<string, string[]>>;
  /** project -> key -> true once promoted (never re-queue) */
  promoted: Record<string, Record<string, boolean>>;
}

const CROSS_SESSION_THRESHOLD = 2;

export class CrossSessionLedger {
  private state: LedgerState;

  constructor(private readonly statePath: string) {
    this.state = this.load();
  }

  private load(): LedgerState {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf-8')) as LedgerState;
        if (raw.version === 1 && raw.sessions && raw.promoted) return raw;
      } catch { /* corrupt: fall through to fresh */ }
    }
    return { version: 1, sessions: {}, promoted: {} };
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
  }

  private proj(project: string): string {
    // normalize separators for stable scoping
    return project.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  /** Record that key appeared in sessionFile within project. Idempotent per session. */
  observe(project: string, key: string, sessionFile: string): void {
    const p = this.proj(project);
    const byKey = this.state.sessions[p] ?? (this.state.sessions[p] = {});
    const list = byKey[key] ?? (byKey[key] = []);
    if (!list.includes(sessionFile)) {
      list.push(sessionFile);
      this.persist();
    }
  }

  /** Distinct-session count for a key in a project (provenance for the reviewer). */
  sessionCount(project: string, key: string): number {
    const p = this.proj(project);
    return this.state.sessions[p]?.[key]?.length ?? 0;
  }

  isPromoted(project: string, key: string): boolean {
    const p = this.proj(project);
    return this.state.promoted[p]?.[key] === true;
  }

  /**
   * Keys that NOW cross the threshold and were not promoted yet.
   * Returns each key once — the caller queues and promotes.
   */
  newlyCrossing(project: string): string[] {
    const p = this.proj(project);
    const byKey = this.state.sessions[p] ?? {};
    const promotedHere = this.state.promoted[p] ?? {};
    const out: string[] = [];
    for (const key of Object.keys(byKey)) {
      if (!promotedHere[key] && byKey[key].length >= CROSS_SESSION_THRESHOLD) {
        out.push(key);
      }
    }
    return out;
  }

  markPromoted(project: string, key: string): void {
    const p = this.proj(project);
    const promotedHere = this.state.promoted[p] ?? (this.state.promoted[p] = {});
    promotedHere[key] = true;
    this.persist();
  }
}