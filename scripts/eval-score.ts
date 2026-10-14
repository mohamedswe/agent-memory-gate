/**
 * eval-score.ts — score Codex rollout JSONL(s) for the memory A/B eval.
 *
 * Parses session rollouts and reports, per session: total/uncached input tokens,
 * output tokens, reasoning tokens, tool-call count, wall time, and the commands
 * executed. Deterministic; reads only; no network.
 *
 * Usage:
 *   bun scripts/eval-score.ts <rollout.jsonl> [<rollout.jsonl> ...]
 *
 * Multiple rollouts are printed side by side in argument order (label = filename).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

interface Usage { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number; total_tokens: number; }
interface Score {
  label: string;
  input: number; cached: number; uncached: number; output: number; reasoning: number;
  toolCalls: number; cmds: string[]; start: string | null; end: string | null;
}

function parse(path: string): Score {
  const s: Score = { label: basename(path), input: 0, cached: 0, uncached: 0, output: 0, reasoning: 0, toolCalls: 0, cmds: [], start: null, end: null };
  const text = readFileSync(path, 'utf-8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const p = (d.payload ?? {}) as Record<string, unknown>;
    if (typeof d.timestamp === 'string') {
      if (!s.start) s.start = d.timestamp;
      s.end = d.timestamp as string;
    }
    if (d.type === 'token_usage_record' || (d.type === 'event_msg' && p.type === 'token_count')) {
      const u = (p.total_token_usage ?? p.info?.total_token_usage ?? {}) as Partial<Usage>;
      if (typeof u.input_tokens === 'number') {
        s.input = Math.max(s.input, u.input_tokens);
        s.cached = Math.max(s.cached, u.cached_input_tokens ?? 0);
        s.output = Math.max(s.output, u.output_tokens ?? 0);
        s.reasoning = Math.max(s.reasoning, u.reasoning_output_tokens ?? 0);
        s.total = Math.max(s.total, u.total_tokens ?? 0);
      }
    }
    if (d.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        s.toolCalls++;
        try {
          const raw = p.type === 'custom_tool_call' ? String(p.input ?? '') : String(p.arguments ?? '');
          const m = raw.match(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) s.cmds.push(m[1].replace(/\\r|\\n/g, ' ').slice(0, 100));
        } catch { /* keep going */ }
      }
    }
  }
  s.uncached = s.input - s.cached;
  return s;
}

declare global { interface Score { total: number; } }

const scores = process.argv.slice(2).map(parse);
if (scores.length === 0) { console.error('usage: bun scripts/eval-score.ts <rollout.jsonl> [...]'); process.exit(1); }

const rows: Array<[string, (s: Score) => string]> = [
  ['input tokens', s => String(s.input)],
  ['  cached', s => String(s.cached)],
  ['  uncached', s => String(s.uncached)],
  ['output tokens', s => String(s.output)],
  ['reasoning tokens', s => String(s.reasoning)],
  ['total tokens', s => String(s.input + s.output)],
  ['tool calls', s => String(s.toolCalls)],
  ['wall time', s => s.start && s.end ? `${((Date.parse(s.end) - Date.parse(s.start)) / 1000).toFixed(0)}s` : '?'],
];

const widths = scores.map(sc => Math.max(sc.label.length, ...rows.map(r => r[1](sc).length)));
console.log(['metric', ...scores.map(sc2 => sc2.label)].map((h, i) => h.padEnd(i === 0 ? 16 : widths[i - 1] + 2)).join(''));
for (const [name, fn] of rows) {
  console.log([name.padEnd(16), ...scores.map((sc, i) => fn(sc).padEnd(widths[i] + 2))].join(''));
}
for (const sc of scores) {
  console.log(`\ncommands run in ${sc.label}:`);
  for (const c of sc.cmds) console.log('  - ' + c);
}