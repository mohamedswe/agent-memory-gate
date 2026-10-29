/** Bounded experiment transport. Credentials are never persisted in artifacts. */
import { readFileSync, mkdirSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from './budget-ledger';

export function inferenceAuth() {
  let token = process.env.OPENAI_API_KEY ?? '', base = process.env.OPENAI_BASE_URL ?? '';
  if (!token || !base) {
    const auth = JSON.parse(readFileSync(join(homedir(), '.hermes/profiles/edge/auth.json'), 'utf8'));
    token ||= auth.providers?.nous?.access_token ?? '';
    base ||= auth.providers?.nous?.inference_base_url ?? '';
  }
  if (!token || !base || !base.startsWith('https://')) throw new Error('MISSING_INFERENCE_AUTH');
  return { token, base: base.replace(/\/$/, '') };
}

export class EvalProvider {
  readonly model = 'z-ai/glm-5.3';
  private constructor(private readonly root: string, private readonly ledger: BudgetLedger,
    private readonly auth: { token: string; base: string }, private readonly post: typeof fetch) {}
  static async open(root: string, capUsd = 5, deps: { auth?: { token: string; base: string }; post?: typeof fetch } = {}) {
    mkdirSync(root, { recursive: true });
    const ledger = await BudgetLedger.open(join(root, 'budget.db'), { monthlyCapUsd: capUsd, periodStart: '2026-10-27-trial' });
    return new EvalProvider(root, ledger, deps.auth ?? inferenceAuth(), deps.post ?? fetch);
  }
  async call(label: string, body: Record<string, unknown>) {
    if (existsSync(join(this.root, 'HALTED.json'))) throw new Error('EXPERIMENT_ACCOUNTING_HALTED');
    const key = `${label}-${crypto.randomUUID()}`;
    // Conservative per-request reservation, bounded input and output. Missing
    // usage.cost holds this reservation and stops further experiment calls.
    const reserveUsd = 0.25;
    if (JSON.stringify(body).length > 110000) throw new Error('INPUT_BUDGET_EXCEEDED');
    const reservation = this.ledger.reserve(key, reserveUsd);
    if (!reservation.reserved) throw new Error('EXPERIMENT_BUDGET_EXHAUSTED');
    const start = Date.now();
    let response: Response;
    try {
      response = await this.post(`${this.auth.base}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: this.model, max_tokens: 4096, temperature: 0, stream: false }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      this.log({ key, label, status: 'ambiguous_network_failure', heldUsd: reserveUsd, elapsedMs: Date.now() - start });
      this.halt('ambiguous network failure');
      throw new Error('INFERENCE_NETWORK_FAILURE_RESERVATION_HELD');
    }
    let data: any;
    try { data = await response.json(); } catch { this.halt('invalid response JSON'); throw new Error('INFERENCE_INVALID_JSON_RESERVATION_HELD'); }
    const actual = data.usage?.cost;
    const validCost = typeof actual === 'number' && Number.isFinite(actual) && actual >= 0;
    if (validCost) this.ledger.reconcile(key, actual);
    this.log({ key, label, status: response.status, model: data.model ?? this.model,
      usage: data.usage ?? null, actualCostUsd: validCost ? actual : null,
      heldUsd: validCost ? 0 : reserveUsd, elapsedMs: Date.now() - start });
    if (!response.ok) throw new Error(`INFERENCE_HTTP_${response.status}`);
    if (!validCost) { this.halt('missing cost'); throw new Error('MISSING_COST_RESERVATION_HELD'); }
    if (!data.choices?.[0]?.message) throw new Error('INFERENCE_MISSING_MESSAGE');
    return data;
  }
  private log(value: unknown) { appendFileSync(join(this.root, 'inference.jsonl'), JSON.stringify(value) + '\n'); }
  private halt(reason: string) { writeFileSync(join(this.root, 'HALTED.json'), JSON.stringify({ reason, at: new Date().toISOString() })); }
  remaining() { return this.ledger.remainingUsd(); }
  close() { return this.ledger.close(); }
}
