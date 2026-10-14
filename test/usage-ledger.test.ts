import { expect, test } from 'bun:test';
import { UsageLedger } from '../src/usage-ledger';

// Slice 4 — normalization: case/punctuation/whitespace variants of the same
// user statement converge on one key. Slice 5 — distinct statements stay
// distinct; counts never bleed between keys.

test('normalization folds case, punctuation, and whitespace variants into one key', () => {
  const ledger = new UsageLedger();
  ledger.recordUserMention('  The   build uses PGLite, not Postgres.  ');
  ledger.recordUserMention('the build uses pglite not postgres');

  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(1);
  expect(candidates[0].key).toBe('the build uses pglite not postgres');
  expect(candidates[0].counts.userRepeats).toBe(2);
});

test('distinct keys stay distinct and counts never bleed', () => {
  const ledger = new UsageLedger();
  ledger.recordUserMention('The build uses PGLite, not Postgres.');
  ledger.recordUserMention('We deploy on Fridays only'); // distinct, single
  ledger.recordUserMention('the build uses pglite not postgres'); // repeat of first

  const candidates = ledger.promotionCandidates();
  expect(candidates).toHaveLength(1);
  expect(candidates[0].counts.userRepeats).toBe(2);

  const single = ledger.countsFor('we deploy on fridays only');
  expect(single!.userRepeats).toBe(1);
  expect(ledger.countsFor('never said at all')).toBeNull();
});
