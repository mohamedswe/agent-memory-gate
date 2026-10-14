/**
 * eval-collect.ts — archive rollouts for a memory A/B eval run.
 *
 * Finds Codex rollout JSONLs whose session cwd matches a given eval workspace
 * directory (baseline/ or memory/ under the run dir), copies each raw JSONL
 * into <run>/transcripts/<condition>/<filename>, and writes a sidecar
 * events.txt (timestamped human-readable event log) plus an index.json
 * covering both conditions with token/tool/time summary and file hashes.
 *
 * Usage:
 *   bun scripts/eval-collect.ts <run-dir>
 *   e.g. bun scripts/eval-collect.ts C:/.../.eval-local/run-03-rep1
 *
 * Reads every rollout-*.jsonl under ~/.codex/sessions (mtime within since-days, default 2). (mtime within --since-days, default 2).
 * Idempotent: re-running refreshes transcripts and the index.
 */
import { readdirSync, statSync, copyFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';

const runDir = resolve(process.argv[2] ?? '');
if (!runDir || !existsSync(runDir)) {
  console.error('usage: bun scripts/eval-collect.ts <run-dir>');
  process.exit(1);
}

const sinceDays = Number(process.argv[3] ?? 2);
const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
const sessionsRoot = join(homedir(), '.codex', 'sessions');

interface RolloutInfo {
  path: string; cwd: string; startTime: string; mtimeMs: number;
  inputTokens: number; cachedTokens: number; outputTokens: number;
  reasoningTokens: number; toolCalls: number; eventCount: number; hasCumulative?: boolean;
}
interface JsonLine { type?: string; timestamp?: string; payload?: Record<string, unknown>; }

function scanRollouts(): RolloutInfo[] {
  const found: RolloutInfo[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          if (statSync(p).mtimeMs < cutoff) continue;
          const text = readFileSync(p, 'utf-8');
          const info: RolloutInfo = {
            path: p, cwd: '', startTime: '', mtimeMs: statSync(p).mtimeMs,
            inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, toolCalls: 0, eventCount: 0,
          };
          for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            let d: JsonLine;
            try { d = JSON.parse(t) as JsonLine; } catch { continue; }
            info.eventCount++;
            const pl = d.payload ?? {};
            if (d.type === 'session_meta' && typeof pl.cwd === 'string') info.cwd = pl.cwd;
            if (d.timestamp && !info.startTime) info.startTime = d.timestamp;
            // token_count events carry the cumulative session usage under info.total_token_usage;
            // token_usage_record payloads carry per-turn usage. Prefer cumulative when seen.
            const cum = ((pl.info as Record<string, unknown> | undefined)?.total_token_usage ?? pl.total_token_usage) as Record<string, number> | undefined;
            const perTurn = pl.usage as Record<string, number> | undefined;
            const pick = (v: Record<string, number> | undefined): boolean => !!v && typeof v.input_tokens === 'number';
            if (pick(cum)) {
              info.inputTokens = Math.max(info.inputTokens, cum!.input_tokens);
              info.cachedTokens = Math.max(info.cachedTokens, cum!.cached_input_tokens ?? 0);
              info.outputTokens = Math.max(info.outputTokens, cum!.output_tokens ?? 0);
              info.reasoningTokens = Math.max(info.reasoningTokens, cum!.reasoning_output_tokens ?? 0);
              info.hasCumulative = true;
            } else if (pick(perTurn) && !info.hasCumulative) {
              info.inputTokens = Math.max(info.inputTokens, perTurn!.input_tokens);
              info.cachedTokens = Math.max(info.cachedTokens, perTurn!.cached_input_tokens ?? 0);
              info.outputTokens = Math.max(info.outputTokens, perTurn!.output_tokens ?? 0);
              info.reasoningTokens = Math.max(info.reasoningTokens, perTurn!.reasoning_output_tokens ?? 0);
            }
            if (d.type === 'response_item' && (pl.type === 'function_call' || pl.type === 'custom_tool_call')) info.toolCalls++;
          }
          if (info.cwd) found.push(info);
        } catch { /* unreadable rollout — skip */ }
      }
    }
  };
  if (existsSync(sessionsRoot)) walk(sessionsRoot, 0);
  return found;
}

function conditionFor(cwd: string): 'baseline' | 'memory' | null {
  const norm = cwd.toLowerCase().replace(/\\/g, '/');
  if (!norm.includes('/.eval-local/')) return null;
  if (norm.endsWith('/baseline')) return 'baseline';
  if (norm.endsWith('/memory')) return 'memory';
  return null;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function eventDump(path: string): string {
  const out: string[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let d: JsonLine;
    try { d = JSON.parse(t) as JsonLine; } catch { continue; }
    const pl = d.payload ?? {};
    const ts = typeof d.timestamp === 'string' ? d.timestamp : '';
    if (d.type === 'event_msg') {
      if (pl.type === 'user_message') out.push(`${ts} USER: ${String(pl.message ?? '').slice(0, 500)}`);
      else if (pl.type === 'agent_message') out.push(`${ts} ASSISTANT: ${String(pl.message ?? '').slice(0, 2000)}`);
    } else if (d.type === 'response_item') {
      if (pl.type === 'function_call' || pl.type === 'custom_tool_call') {
        const raw = pl.type === 'custom_tool_call' ? String(pl.input ?? '') : String(pl.arguments ?? '');
        out.push(`${ts} TOOL_CALL: ${raw.slice(0, 500)}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

const rollouts = scanRollouts();
const conds: Array<'baseline' | 'memory'> = ['baseline', 'memory'];
const index: Record<string, unknown> = {
  run_dir: runDir,
  collected_at: new Date().toISOString(),
  search_window_days: sinceDays,
  conditions: {} as Record<string, unknown>,
};

for (const cond of conds) {
  const ws = join(runDir, cond);
  if (!existsSync(ws)) continue;
  const matches = rollouts.filter(r => conditionFor(r.cwd) === cond && r.cwd.toLowerCase() === ws.toLowerCase());
  matches.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const condEntry: Record<string, unknown> = { workspaces: [ws], sessions: [] as unknown[] };
  const sessionsArr = condEntry.sessions as Array<Record<string, unknown>>;
  for (const m of matches) {
    const destDir = join(runDir, 'transcripts', cond);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, basename(m.path));
    copyFileSync(m.path, dest);
    writeFileSync(join(destDir, basename(m.path).replace('.jsonl', '.events.txt')), eventDump(m.path));
    sessionsArr.push({
      file: dest, original_path: m.path, started: m.startTime, mtime: new Date(m.mtimeMs).toISOString(),
      sha256: sha256(dest),
      input_tokens: m.inputTokens, cached_input_tokens: m.cachedTokens,
      uncached_input_tokens: m.inputTokens - m.cachedTokens,
      output_tokens: m.outputTokens, reasoning_tokens: m.reasoningTokens,
      tool_calls: m.toolCalls, jsonl_lines: m.eventCount,
    });
  }
  (index.conditions as Record<string, unknown>)[cond] = condEntry;
  console.log(`${cond}: ${sessionsArr.length} session(s) archived`);
}

writeFileSync(join(runDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`index: ${join(runDir, 'index.json')}`);
