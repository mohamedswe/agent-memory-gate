// Acceptance probe: aggregate counts from ONE real rollout passed as argv[2].
// Prints schema-level stats only — no session text is emitted or stored.
import { parseRollout, feedLedger } from '../src/rollout-reader';
import { UsageLedger } from '../src/usage-ledger';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const text = readFileSync(path, 'utf-8');
const rollout = parseRollout(text);
const ledger = new UsageLedger();
feedLedger(ledger, rollout);
const candidates = ledger.promotionCandidates();
console.log(JSON.stringify({
  meta_ok: Boolean(rollout.meta.sessionId || rollout.meta.cwd),
  events: rollout.events.length,
  kinds: rollout.events.reduce((m, e) => (m[e.kind] = (m[e.kind] ?? 0) + 1, m), {} as Record<string, number>),
  candidates: candidates.length,
}));
