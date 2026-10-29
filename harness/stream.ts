/**
 * Parse Claude Code `--output-format stream-json --verbose` output into the
 * metrics the harness logs. Shared by smoke.ts and the run loop.
 *
 * Memory-use detection (fixed after the first smoke run): an agent can see
 * memory content without opening the file, e.g. a folder-wide Grep returns
 * the matching lines. So "memory touched" is true if EITHER
 *   - a tool call's input names a path under .project-memory, OR
 *   - any tool RESULT returned to the agent contains the memory marker
 *     (a unique string the harness embeds in every memory file) or a
 *     .project-memory path.
 * The second check catches Grep, Bash `cat`, Glob listings, etc.
 */

export const MEMORY_DIR = '.project-memory';

export interface ToolCall { name: string; target: string }

export interface StreamMetrics {
  ok: boolean;
  isError: boolean;
  answer: string;
  numTurns: number | null;
  costUsd: number | null;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  /** input + cache_creation: tokens the model processed fresh this session */
  newInputTokens: number;
  /** new + cache reads: everything the model was shown */
  totalInputTokens: number;
  toolCalls: ToolCall[];
  memoryTouched: boolean;
  memoryTouchedVia: ('tool_input' | 'tool_result')[];
  rateLimitEvents: number;
  permissionDenials: number;
  eventTypes: Record<string, number>;
  sessionId: string | null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : (c as any)?.text ?? JSON.stringify(c))).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

const norm = (s: string) => s.replace(/\\\\/g, '/').replace(/\\/g, '/');

export function parseStream(raw: string, opts: { runDir?: string; marker?: string } = {}): StreamMetrics {
  const eventTypes: Record<string, number> = {};
  const toolCalls: ToolCall[] = [];
  const via = new Set<'tool_input' | 'tool_result'>();
  let result: any = null;
  let rateLimitEvents = 0;
  const runDir = opts.runDir ? norm(opts.runDir) : null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = `${ev.type ?? '?'}${ev.subtype ? ':' + ev.subtype : ''}`;
    eventTypes[t] = (eventTypes[t] ?? 0) + 1;
    if (ev.type === 'rate_limit_event') rateLimitEvents++;
    const content = ev?.message?.content;
    if (!Array.isArray(content)) { if (ev.type === 'result') result = ev; continue; }

    if (ev.type === 'assistant') {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        const inputStr = norm(JSON.stringify(c.input ?? {}));
        const inp = c.input ?? {};
        let target = norm(String(inp.file_path ?? inp.path ?? inp.pattern ?? inp.command ?? ''));
        if (runDir) target = target.split(runDir).join('<run-dir>');
        toolCalls.push({ name: String(c.name), target: target.slice(0, 200) });
        if (inputStr.includes(MEMORY_DIR)) via.add('tool_input');
      }
    }
    if (ev.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        const txt = norm(textOf(c.content));
        if (txt.includes(MEMORY_DIR) || (opts.marker && txt.includes(opts.marker))) via.add('tool_result');
      }
    }
  }

  const u = result?.usage ?? {};
  const usage = {
    input_tokens: Number(u.input_tokens ?? 0),
    cache_creation_input_tokens: Number(u.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(u.cache_read_input_tokens ?? 0),
    output_tokens: Number(u.output_tokens ?? 0),
  };
  const newInputTokens = usage.input_tokens + usage.cache_creation_input_tokens;
  return {
    ok: !!result && result.is_error !== true,
    isError: result?.is_error === true,
    answer: String(result?.result ?? ''),
    numTurns: typeof result?.num_turns === 'number' ? result.num_turns : null,
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    usage,
    newInputTokens,
    totalInputTokens: newInputTokens + usage.cache_read_input_tokens,
    toolCalls,
    memoryTouched: via.size > 0,
    memoryTouchedVia: [...via],
    rateLimitEvents,
    permissionDenials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0,
    eventTypes,
    sessionId: result?.session_id ?? null,
  };
}
