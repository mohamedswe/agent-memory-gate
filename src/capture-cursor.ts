/**
 * Capture cursor — durable record of which Codex session rollout files have
 * already been captured into the pipeline, keyed by identity (path + mtime +
 * size), not name alone. A rollout that grew (session appended a turn) or
 * was rewritten is NEW again and gets re-captured.
 *
 * Deterministic only: JSON state file, no inference, no network, no brain.
 * The state file lives under the pipeline store dir (default live-run/).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface FileIdentity {
  path: string;
  mtimeMs: number;
  size: number;
}

interface CursorState {
  version: 1;
  processed: Record<string, FileIdentity>; // key: absolute path (forward-slashed)
}

export function cursorPath(storeDir: string): string {
  return join(storeDir, 'capture-cursor.json');
}

function keyFor(path: string): string {
  return path.replace(/\\/g, '/');
}

export class CaptureCursor {
  private state: CursorState;
  constructor(private readonly statePath: string) {
    this.state = this.load();
  }

  private load(): CursorState {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf-8')) as CursorState;
        if (raw.version === 1 && raw.processed && typeof raw.processed === 'object') return raw;
      } catch { /* corrupt state: fall through to fresh */ }
    }
    return { version: 1, processed: {} };
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
  }

  /** Identity of a file right now; null if missing/unreadable. */
  private identity(path: string): FileIdentity | null {
    try {
      const st = statSync(path);
      return { path: keyFor(path), mtimeMs: st.mtimeMs, size: st.size };
    } catch { return null; }
  }

  isProcessed(path: string): boolean {
    const id = this.identity(path);
    if (!id) return false;
    const rec = this.state.processed[id.path];
    return !!rec && rec.mtimeMs === id.mtimeMs && rec.size === id.size;
  }

  markProcessed(path: string): void {
    const id = this.identity(path);
    if (!id) return;
    this.state.processed[id.path] = id;
    this.persist();
  }

  processedCount(): number {
    return Object.keys(this.state.processed).length;
  }

  clear(): void {
    this.state = { version: 1, processed: {} };
    this.persist();
  }
}