/**
 * Codex rollout reader — parses Codex session rollout JSONL content
 * into typed events and feeds the session usage ledger. Deterministic, no
 * inference, no file I/O (callers pass file text); parsing is resumable-safe
 * (partial trailing lines skipped, duplicate response items deduped by id).
 */
import type { UsageLedger } from './usage-ledger';

export interface RolloutMeta {
  sessionId: string;
  cwd: string | null;
  branch: string | null;
}

export type RolloutEvent =
  | { kind: 'user_message'; id: string; text: string }
  | { kind: 'assistant_message'; id: string; text: string }
  | { kind: 'tool_call'; id: string; callId: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_output'; id: string; callId: string; text: string };

export interface Rollout {
  meta: RolloutMeta;
  events: RolloutEvent[];
}

interface JsonlLine {
  type: string;
  payload?: Record<string, unknown>;
}

/** Extract message text from observed content shapes (input_text/output_text arrays). */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .map(part => (typeof part === 'object' && part !== null && 'text' in part ? String((part as Record<string, unknown>).text ?? '') : ''))
    .join('\n');
}

export function parseRollout(jsonl: string): Rollout {
  const meta: RolloutMeta = { sessionId: '', cwd: null, branch: null };
  const events: RolloutEvent[] = [];
  const seenIds = new Set<string>();

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(trimmed) as JsonlLine;
    } catch {
      continue; // partial trailing write or corrupt line — skip, resumable cursor handles it upstream
    }

    if (parsed.type === 'session_meta' && parsed.payload) {
      meta.sessionId = String(parsed.payload.id ?? '');
      meta.cwd = typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : null;
      const git = parsed.payload.git as Record<string, unknown> | undefined;
      meta.branch = git && typeof git.branch === 'string' ? git.branch : null;
      continue;
    }

    if (parsed.type !== 'response_item' || !parsed.payload) continue;
    const p = parsed.payload;
    const id = String(p.id ?? '');

    const push = (event: RolloutEvent) => {
      if (seenIds.has(id)) return; // wrapper lines and replays can repeat response items
      seenIds.add(id);
      events.push(event);
    };

    switch (p.type) {
      case 'message': {
        if (p.role === 'user' || p.role === 'assistant') {
          push({
            kind: p.role === 'user' ? 'user_message' : 'assistant_message',
            id,
            text: messageText(p.content),
          });
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        let args: Record<string, unknown> = {};
        if (typeof p.arguments === 'string') {
          try { args = JSON.parse(p.arguments) as Record<string, unknown>; } catch { args = {}; }
        } else if (p.input !== undefined) {
          args = { input: String(p.input) };
        }
        push({ kind: 'tool_call', id, callId: String(p.call_id ?? id), name: String(p.name ?? ''), args });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        push({ kind: 'tool_output', id, callId: String(p.call_id ?? id), text: typeof p.output === 'string' ? p.output : messageText(p.output) });
        break;
      }
      default:
        break; // reasoning, unknown variants — recorded upstream by the cursor, not ledger events
    }
  }

  return { meta, events };
}

/** Feed parsed events into a usage ledger using its signal semantics. */
export function feedLedger(ledger: UsageLedger, rollout: Rollout): void {
  for (const event of rollout.events) {
    switch (event.kind) {
      case 'user_message':
        ledger.recordUserMention(event.text);
        break;
      case 'tool_call':
        ledger.recordToolCall(event.name, event.args);
        break;
      case 'assistant_message':
        ledger.recordRawMention(event.text);
        break;
      case 'tool_output':
        break; // v1: outputs are evidence material, not usage signals
    }
  }
}
