import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedOdds, legsBlock, ticketSummary } from '../src/services/ticket-math.js';

test('combined odds multiply the legs without float noise', () => {
  assert.equal(combinedOdds([1.9, 2.1, 1.5]), 5.985);
  assert.equal(combinedOdds([1.1, 1.1, 1.1]), 1.331);
});

test('legs need 2 to 10 selections and one outcome per match', () => {
  assert.equal(legsBlock([{ eventId: 'a' }]).code, 'TOO_FEW_LEGS');
  assert.equal(legsBlock(Array.from({ length: 11 }, (_, i) => ({ eventId: `e${i}` }))).code, 'TOO_MANY_LEGS');
  assert.equal(legsBlock([{ eventId: 'a' }, { eventId: 'a' }]).code, 'DUPLICATE_EVENT');
  assert.equal(legsBlock([{ eventId: 'a' }, { eventId: 'b' }]), null);
});

test('the profit cap lowers the stake and the summary reports profit and return', () => {
  // odds 4.0 -> net profit per naira is 3; cap of 3,000 allows at most a 1,000 stake
  const capped = ticketSummary({ oddsList: [2, 2], stakeMinor: 500_000, maxNetProfitMinor: 300_000 });
  assert.equal(capped.combinedOdds, 4);
  assert.equal(capped.effectiveStakeMinor, 100_000);
  assert.equal(capped.stakeAdjusted, true);
  assert.equal(capped.potentialNetProfitMinor, 300_000);
  assert.equal(capped.potentialReturnMinor, 400_000);
});

test('a stake already under the cap is kept', () => {
  const kept = ticketSummary({ oddsList: [1.5, 1.5], stakeMinor: 100_000, maxNetProfitMinor: 10_000_000 });
  assert.equal(kept.effectiveStakeMinor, 100_000);
  assert.equal(kept.stakeAdjusted, false);
  assert.equal(kept.potentialNetProfitMinor, 125_000);
});

test('combined odds above 1000 are refused', () => {
  assert.throws(() => ticketSummary({ oddsList: [10, 10, 10, 2], stakeMinor: 100_000, maxNetProfitMinor: 1_000_000 }), { code: 'COMBINED_ODDS_TOO_HIGH' });
});
