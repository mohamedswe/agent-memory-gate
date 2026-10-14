import { expect, test } from 'bun:test';
import { UsageLedger } from '../src/usage-ledger';

// Slice 6 — low-content keys never promote. Real-session acceptance probing
// showed bare "continue" and empty strings crossing the user-repeat threshold;
// they are conversational flow, not information. A candidate must carry a
// minimum amount of actual content.

test('low-content keys are counted but never promoted', () => {
  const ledger = new UsageLedger();
  ledger.recordUserMention('continue');
  ledger.recordUserMention('Continue.');
  ledger.recordUserMention('');
  ledger.recordUserMention('   ');
  ledger.recordUserMention('ok');
  ledger.recordUserMention('ok');

  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(0);
  // Still observed, just not promotable:
  expect(ledger.countsFor('continue')!.userRepeats).toBe(2);
  expect(ledger.countsFor('ok')!.userRepeats).toBe(2);
});

test('meaningful short statements still promote', () => {
  const ledger = new UsageLedger();
  ledger.recordUserMention('use bun');
  ledger.recordUserMention('Use Bun.');

  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(1);
  expect(candidates[0].key).toBe('use bun');
});
