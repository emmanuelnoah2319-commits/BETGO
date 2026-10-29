import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedOdds as clientOdds, minorToNaira, nairaToMinor, summarizeTicket } from '../public/ticket-calc.js';
import { combinedOdds as serverOdds, ticketSummary } from '../src/services/ticket-math.js';

test('nairaToMinor accepts plain naira amounts and rejects everything else', () => {
  assert.equal(nairaToMinor('5000'), 500000);
  assert.equal(nairaToMinor('₦1,250.5'), 125050);
  assert.equal(nairaToMinor(' 0.99 '), 99);
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', null, undefined]) assert.equal(nairaToMinor(bad), null, String(bad));
  assert.equal(minorToNaira(125050), '₦1,250.50');
});

test('the browser preview matches the server for combined odds, stake cap, profit and return', () => {
  const cases = [
    { oddsList: [2], stakeMinor: 500_000, maxNetProfitMinor: 300_000 },
    { oddsList: [2, 2], stakeMinor: 500_000, maxNetProfitMinor: 300_000 },
    { oddsList: [1.9, 2.1, 1.5], stakeMinor: 100_000, maxNetProfitMinor: 10_000_000 },
    { oddsList: [1.45, 3.2, 2.05, 1.18], stakeMinor: 2_500_000, maxNetProfitMinor: 1_000_000 },
    { oddsList: [4.1], stakeMinor: 5_000_000, maxNetProfitMinor: 1_000_000 }
  ];
  for (const input of cases) {
    assert.equal(clientOdds(input.oddsList), serverOdds(input.oddsList));
    const { error, ...client } = summarizeTicket(input);
    assert.equal(error, undefined);
    assert.deepEqual(client, ticketSummary(input));
  }
});

test('a max profit that lowers the stake is reported, and one that is too low is refused with a message', () => {
  const lowered = summarizeTicket({ oddsList: [4], stakeMinor: 500_000, maxNetProfitMinor: 300_000 });
  assert.equal(lowered.effectiveStakeMinor, 100_000);
  assert.equal(lowered.stakeAdjusted, true);
  assert.equal(lowered.potentialNetProfitMinor, 300_000);
  assert.match(summarizeTicket({ oddsList: [500], stakeMinor: 100_000, maxNetProfitMinor: 10_000 }).error, /too low/);
  assert.match(summarizeTicket({ oddsList: [2], stakeMinor: null, maxNetProfitMinor: 10_000 }).error, /stake/i);
  assert.match(summarizeTicket({ oddsList: [2], stakeMinor: 10_000, maxNetProfitMinor: null }).error, /maximum profit/i);
  assert.match(summarizeTicket({ oddsList: [10, 10, 10, 2], stakeMinor: 100_000, maxNetProfitMinor: 1_000_000 }).error, /exceed/);
});
