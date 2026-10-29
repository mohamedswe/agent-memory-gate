/** Offline accounting shared by eval-score and eval-collect. Missing is not zero. */
export interface EvalUsage { input: number; cached: number; uncached: number; output: number; reasoning: number | null; total: number }
export interface EvalMetrics {
  usage: EvalUsage | null; accounting: 'cumulative' | 'per-turn' | 'missing' | 'invalid';
  issues: string[]; toolCalls: number; commands: string[]; start: string | null; end: string | null;
  elapsedSeconds: number | null; malformedLines: number; sessionIds: string[];
}
type Obj = Record<string, any>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
function usageOf(v: unknown): EvalUsage | null {
  const u = obj(v);
  if (!('input_tokens' in u)) return null;
  const input = u.input_tokens, output = u.output_tokens;
  const cached = u.cached_input_tokens ?? obj(u.input_tokens_details).cached_tokens ?? 0;
  const reasoning = u.reasoning_output_tokens ?? obj(u.output_tokens_details).reasoning_tokens ?? null;
  if (![input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input ||
    (reasoning !== null && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output))) throw new Error('INVALID_USAGE');
  return { input, cached, uncached: input - cached, output, reasoning, total: input + output };
}
function sum(values: EvalUsage[]): EvalUsage {
  return values.reduce((a, b) => ({ input: a.input + b.input, cached: a.cached + b.cached,
    uncached: a.uncached + b.uncached, output: a.output + b.output,
    reasoning: a.reasoning === null || b.reasoning === null ? null : a.reasoning + b.reasoning,
    total: a.total + b.total }), { input: 0, cached: 0, uncached: 0, output: 0, reasoning: 0, total: 0 });
}
export function parseEvalMetrics(jsonl: string): EvalMetrics {
  const r: EvalMetrics = { usage: null, accounting: 'missing', issues: [], toolCalls: 0, commands: [],
    start: null, end: null, elapsedSeconds: null, malformedLines: 0, sessionIds: [] };
  const totals = new Map<string, EvalUsage>(), turns = new Map<string, EvalUsage[]>();
  const seenUsage = new Set<string>(), seenTools = new Set<string>();
  let session = 'default', invalid = false;
  for (const [i, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let d: Obj;
    try { d = obj(JSON.parse(line.replace(/^\uFEFF/, ''))); } catch { r.malformedLines++; continue; }
    const p = obj(d.payload);
    if (d.type === 'session_meta' || d.type === 'thread.started') {
      session = String(p.id ?? d.thread_id ?? session);
      if (!r.sessionIds.includes(session)) r.sessionIds.push(session);
    }
    if (typeof d.timestamp === 'string' && Number.isFinite(Date.parse(d.timestamp))) {
      if (!r.start || Date.parse(d.timestamp) < Date.parse(r.start)) r.start = d.timestamp;
      if (!r.end || Date.parse(d.timestamp) > Date.parse(r.end)) r.end = d.timestamp;
    }
    if (d.type === 'token_usage_record' || (d.type === 'event_msg' && p.type === 'token_count') || d.type === 'turn.completed') {
      const info = obj(p.info), cumulative = p.total_token_usage ?? info.total_token_usage;
      const raw = cumulative ?? p.usage ?? info.last_token_usage ?? d.usage;
      const id = p.request_id ?? p.turn_id ?? d.request_id ?? d.id;
      const key = id ? `${session}:${cumulative ? 'cum' : 'turn'}:${id}` : null;
      if (key && seenUsage.has(key)) continue;
      if (key) seenUsage.add(key);
      try {
        const value = usageOf(raw);
        if (value && cumulative) {
          const prev = totals.get(session);
          if (prev && (value.input < prev.input || value.cached < prev.cached || value.output < prev.output)) {
            invalid = true; r.issues.push(`cumulative counters regressed at line ${i + 1}`);
          }
          totals.set(session, value);
        } else if (value) { const list = turns.get(session) ?? []; list.push(value); turns.set(session, list); }
      } catch { invalid = true; r.issues.push(`invalid usage at line ${i + 1}`); }
    }
    const item = d.type === 'response_item' ? p : obj(d.item);
    const call = ['function_call', 'custom_tool_call'].includes(item.type);
    const exec = d.type === 'item.completed' && item.type === 'command_execution';
    if (call || exec) {
      const id = item.call_id ?? item.id, key = id ? `${session}:${id}` : `${session}:line:${i}`;
      if (seenTools.has(key)) continue;
      seenTools.add(key); r.toolCalls++;
      if (exec && typeof item.command === 'string') r.commands.push(item.command);
      else {
        let args = obj(item.arguments);
        if (typeof item.arguments === 'string') { try { args = obj(JSON.parse(item.arguments)); } catch { /* non-JSON custom input */ } }
        const command = args.cmd ?? args.command;
        if (typeof command === 'string') r.commands.push(command);
        else if (typeof item.input === 'string' && /shell|exec/.test(item.name ?? '')) r.commands.push(item.input);
      }
    }
  }
  const sessions = new Set([...totals.keys(), ...turns.keys()]);
  const values = [...sessions].map(id => totals.get(id) ?? sum(turns.get(id)!));
  if (invalid) r.accounting = 'invalid';
  else if (values.length) { r.usage = sum(values); r.accounting = totals.size ? 'cumulative' : 'per-turn'; }
  else r.issues.push('no usable token accounting');
  if (r.start && r.end) r.elapsedSeconds = (Date.parse(r.end) - Date.parse(r.start)) / 1000;
  if (r.malformedLines) r.issues.push(`${r.malformedLines} malformed JSONL lines skipped`);
  return r;
}
