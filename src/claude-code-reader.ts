/**
 * Claude Code session reader. Turns `claude -p --output-format stream-json
 * --verbose` output (or an on-disk ~/.claude/projects/<dir>/<id>.jsonl
 * transcript, which uses the same message shapes) into the tool-event
 * stream that env-feedback.ts consumes. Deterministic; no inference.
 *
 * Assumptions to verify against real logs (the pilot checks these):
 *  - Bash calls are tool_use blocks named "Bash" with input.command.
 *  - Their results are tool_result blocks with the same tool_use_id; a failed
 *    command has is_error === true and/or its text reports a non-zero exit code.
 *  - File edits are Edit / MultiEdit / Write / NotebookEdit with input.file_path.
 */
import type { ToolEvent } from './env-feedback';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : (c as any)?.text ?? '')).join('\n');
  return '';
}

export function commandFailed(isError: unknown, output: string): boolean {
  if (isError === true) return true;
  const m = output.match(/exit(?:ed with)? code[:\s]+(-?\d+)/i);
  return !!m && Number(m[1]) !== 0;
}

export function toolEventsFromClaudeCode(raw: string, rootDir?: string): ToolEvent[] {
  const pending = new Map<string, { command: string; index: number }>();
  const events: ToolEvent[] = [];
  let index = 0;
  const rel = (p: string) => {
    let s = p.replace(/\\/g, '/');
    if (rootDir) { const r = rootDir.replace(/\\/g, '/').replace(/\/$/, '') + '/'; if (s.startsWith(r)) s = s.slice(r.length); }
    return s;
  };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (ev.type === 'assistant' && c?.type === 'tool_use') {
        if (c.name === 'Bash' && typeof c.input?.command === 'string') {
          pending.set(c.id, { command: c.input.command, index: index++ });
        } else if (EDIT_TOOLS.has(c.name) && (c.input?.file_path || c.input?.notebook_path)) {
          events.push({ kind: 'edit', index: index++, file: rel(String(c.input.file_path ?? c.input.notebook_path)) });
        }
      } else if (ev.type === 'user' && c?.type === 'tool_result' && pending.has(c.tool_use_id)) {
        const { command, index: i } = pending.get(c.tool_use_id)!;
        pending.delete(c.tool_use_id);
        const output = textOf(c.content);
        events.push({ kind: 'command', index: i, command, ok: !commandFailed(c.is_error, output), output: output.slice(-4000) });
      }
    }
  }
  return events.sort((a, b) => a.index - b.index);
}
