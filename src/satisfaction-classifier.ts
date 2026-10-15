/**
 * Satisfaction classifier — lane 2's ONLY paid stage. One batched call per
 * session classifies every user turn's satisfaction state (pleased /
 * neutral / displeased). Mirrors the reviewer client's discipline exactly:
 *  - estimate -> ATOMIC RESERVE -> HTTP call -> reconcile actual cost ->
 *    validate strict JSON. Cap refusal = no HTTP call.
 *  - malformed output: cost reconciled (tokens were spent), output rejected.
 *  - reasoning_content fallback: GLM-5.3 sometimes returns empty content with
 *    the answer in reasoning; brace-match the first complete JSON object.
 *
 * The classifier NEVER decides what to remember — it only labels the user's
 * reaction. Arc detection (displeased->pleased) and record creation are
 * deterministic downstream stages, not model decisions.
 */
import type { SatisfactionJob, UserTurn } from './session-trajectory';

export type SatisfactionState = 'pleased' | 'neutral' | 'displeased';

export interface TurnVerdict {
  index: number;
  state: SatisfactionState;
}

export interface SatisfactionResult {
  sessionFile: string;
  projectDir: string;
  turns: TurnVerdict[];
  costUsd: number;
}

export interface HttpResponse {
  ok: boolean;
  json: unknown;
}

export interface SatisfactionDeps {
  httpPost: (url: string, body: unknown) => Promise<HttpResponse>;
  budget: {
    reserve: (key: string, usd: number) => { reserved: boolean; reason?: string };
    reconcile: (key: string, usd: number) => void;
    remainingUsd: () => number;
  };
  estimateUsd: () => number;
  endpointUrl?: string;
  model?: string;
}

const SYSTEM_PROMPT = `You classify the user's satisfaction in a coding session. You receive the user's messages to the agent, in order. For EACH message judge the user's reaction to the agent's work up to that point.

Reply with ONLY a JSON object, no markdown, no prose:
{"verdicts": [{"index": <the turn index>, "state": "pleased|neutral|displeased"}]}

Rules:
- One verdict for EVERY turn index given, no more, no less.
- "neutral": task instructions, follow-ups, or no clear reaction.
- "pleased": explicit satisfaction, approval, or confirmation of success.
- "displeased": explicit dissatisfaction, correction, or report of failure.
- Never invent turns. Never skip turns.`;

export function buildSatisfactionPrompt(turns: UserTurn[]): string {
  return [
    'User messages, in order:',
    ...turns.map(t => `[${t.index}] ${t.text.slice(0, 1000)}`),
  ].join('\n');
}

const VALID_STATES = new Set(['pleased', 'neutral', 'displeased']);

function findJsonInProse(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function classifySatisfaction(
  batchKey: string,
  job: SatisfactionJob,
  deps: SatisfactionDeps,
): Promise<SatisfactionResult> {
  // 1. Reserve BEFORE the request. Refusal = no HTTP call.
  const estimate = deps.estimateUsd();
  const reservation = deps.budget.reserve(batchKey, estimate);
  if (!reservation.reserved) {
    throw new Error(`SATISFACTION_BUDGET_REFUSED: ${reservation.reason ?? 'unknown'}`);
  }

  // 2. Call (injected transport).
  let response: HttpResponse;
  try {
    response = await deps.httpPost(deps.endpointUrl ?? '', {
      model: deps.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildSatisfactionPrompt(job.turns) },
      ],
    });
  } catch (error) {
    // Ambiguous failure: reservation stays held; caller retries with a NEW key.
    throw error;
  }

  // 3. Reconcile whatever the transport says it cost — even on bad output.
  const usage = (response.json as { usage?: { cost?: number } })?.usage;
  const actual = typeof usage?.cost === 'number' ? usage.cost : estimate;
  deps.budget.reconcile(batchKey, actual);

  // 4. Validate strictly.
  if (!response.ok) throw new Error('SATISFACTION_HTTP_NOT_OK');
  const message = (response.json as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  })?.choices?.[0]?.message;
  let content = message?.content;
  if (!content || !content.trim()) {
    const reasoning = message?.reasoning_content ?? '';
    const fromProse = findJsonInProse(reasoning);
    if (fromProse === null) throw new Error('SATISFACTION_NO_CONTENT');
    content = JSON.stringify(fromProse);
  }

  let parsed: unknown;
  try {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    parsed = JSON.parse((fenced ? fenced[1] : content).trim());
  } catch {
    throw new Error('SATISFACTION_NO_CONTENT');
  }

  const verdicts = (parsed as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) throw new Error('SATISFACTION_INVALID_VERDICT');

  // exactly one verdict per turn index, states valid
  const seen = new Map<number, TurnVerdict>();
  for (const v of verdicts) {
    if (!v || typeof v !== 'object') throw new Error('SATISFACTION_INVALID_VERDICT');
    const { index, state } = v as Record<string, unknown>;
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new Error('SATISFACTION_INVALID_VERDICT');
    if (typeof state !== 'string' || !VALID_STATES.has(state)) throw new Error(`SATISFACTION_INVALID_VERDICT: ${String(state)}`);
    if (seen.has(index)) throw new Error('SATISFACTION_VERDICT_MISMATCH');
    seen.set(index, { index, state: state as SatisfactionState });
  }
  for (const t of job.turns) {
    if (!seen.has(t.index)) throw new Error('SATISFACTION_VERDICT_MISMATCH');
  }

  return {
    sessionFile: job.sessionFile,
    projectDir: job.projectDir,
    turns: job.turns.map(t => seen.get(t.index)!),
    costUsd: actual,
  };
}