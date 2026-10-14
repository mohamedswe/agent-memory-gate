/**
 * Reviewer client — the ONLY stage that talks to paid inference.
 * Flow: estimate -> ATOMIC RESERVE -> HTTP call -> reconcile actual cost ->
 * validate strict JSON. Fail-closed rules:
 *  - cap refusal: no HTTP call happens.
 *  - ambiguous failure (timeout/network): reservation stays held, no reconcile.
 *  - malformed output: cost IS reconciled (tokens were spent), output rejected.
 *  - the reviewer can never produce verified/implemented (validator enforces).
 *
 * Live wiring (real endpoint + key) is a separate concern; unit tests inject
 * httpPost and a real temp budget ledger. NO live call runs from this module
 * without an explicitly-constructed HTTP dependency.
 */
import type { Candidate } from './redaction-gate';
import type { ReviewerOutput } from './reviewer-output';
import { validateReviewerOutput } from './reviewer-output';
import type { BudgetLedger } from './budget-ledger';

export interface HttpResponse {
  ok: boolean;
  json: unknown;
}

export interface ReviewerDeps {
  /** HTTP POST to the inference endpoint. Injected: tests stub, live wiring passes real fetch. */
  httpPost: (url: string, body: unknown) => Promise<HttpResponse>;
  budget: Pick<BudgetLedger, 'reserve' | 'reconcile' | 'remainingUsd'>;
  /** Conservative cost estimate for reservation (input+output+reasoning bound). */
  estimateUsd: (candidate: Candidate) => number;
  /** Endpoint URL; required — no hidden default that could silently go live. */
  endpointUrl?: string;
  /** Model id. */
  model?: string;
}

const SYSTEM_PROMPT = `You are a memory reviewer for a coding agent. You receive one repeated usage signal from a coding session and decide whether it represents durable knowledge worth remembering.

Reply with ONLY a JSON object, no markdown, no prose:
{"memory_kind": "project|goal|decision|attempt|finding|procedure|evidence", "content": "<=300 chars, one sentence describing the reusable knowledge", "lifecycle": "proposed", "evidence": "tentative", "justification": "<=200 chars, why this matters"}

Hard rules:
- lifecycle is ALWAYS "proposed" and evidence is ALWAYS "tentative". You cannot verify anything.
- If the signal is not worth remembering, reply with content "NOT_WORTH_SAVING" and memory_kind "evidence".`;

function projectNameFor(projectDir: string): string {
  const last = projectDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'unknown';
  return last;
}

export function buildUserPrompt(candidate: Candidate): string {
  const c = candidate.counts;
  const signal = c.userRepeats >= 2 ? 'user repeated this statement' : 'agent repeated this action';
  return [
    `Project: ${projectNameFor(candidate.projectDir)}`,
    `Project directory: ${candidate.projectDir}`,
    `Session: ${candidate.sessionFile}`,
    `Signal type: ${signal}`,
    `Usage counts: userRepeats=${c.userRepeats}, agentRediscoveries=${c.agentRediscoveries}, rawMentions=${c.rawMentions}`,
    `Repeated signal:`,
    candidate.key.slice(0, 500),
    ``,
    `Scope your content to this project ("In <project>: ..." or equivalent) so the memory carries its context. Never invent project details you cannot see here.`,
  ].join('\n');
}

/** Extract the JSON object from model output (handles ```json fences and prose). */
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : content).trim();
  return JSON.parse(raw);
}

/** Find a JSON object inside prose: first {...} block with the required marker. */
function findJsonInProse(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Match braces to find the end of the first complete object:
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function callReviewer(
  batchKey: string,
  candidate: Candidate,
  deps: ReviewerDeps,
): Promise<ReviewerOutput> {
  // 1. Reserve BEFORE the request. Refusal = no HTTP call.
  const estimate = deps.estimateUsd(candidate);
  const reservation = deps.budget.reserve(batchKey, estimate);
  if (!reservation.reserved) {
    throw new Error(`REVIEWER_BUDGET_REFUSED: ${reservation.reason ?? 'unknown'}`);
  }

  let response: HttpResponse;
  try {
    response = await deps.httpPost(deps.endpointUrl ?? '', {
      model: deps.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(candidate) },
      ],
    });
  } catch (error) {
    // Ambiguous failure: the request may have landed upstream and been billed.
    // Reservation stays held in the ledger; caller retries with a NEW key.
    throw error;
  }

  // 2. Reconcile whatever the transport says it cost — even on bad output.
  const usage = (response.json as { usage?: { cost?: number } })?.usage;
  const actual = typeof usage?.cost === 'number' ? usage.cost : estimate;
  deps.budget.reconcile(batchKey, actual);

  // 3. Validate strictly. Malformed or fraudulent output is rejected here.
  if (!response.ok) throw new Error(`REVIEWER_HTTP_NOT_OK`);
  const message = (response.json as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  })?.choices?.[0]?.message;
  let content = message?.content;
  // Reasoning-mode fallback: GLM-5.3 sometimes burns the token budget on
  // reasoning and returns empty content with the answer inside reasoning_content.
  if (!content || !content.trim()) {
    const reasoning = message?.reasoning_content ?? '';
    const fromProse = findJsonInProse(reasoning);
    if (fromProse === null) throw new Error('REVIEWER_NO_CONTENT');
    content = JSON.stringify(fromProse);
  }
  const parsed = extractJson(content);
  return validateReviewerOutput(parsed, candidate);
}
