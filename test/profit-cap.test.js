import test from 'node:test';
import assert from 'node:assert/strict';
import { capStakeToNetProfit } from '../src/services/profit-cap.js';

test('caps stake by net profit excluding returned stake', () => {
  // ₦10,000 profit cap at 1.90 odds allows at most ₦11,111.11 stake.
  assert.equal(capStakeToNetProfit(5000000, 1.9, 1000000), 1111111);
});

test('does not increase a stake already under the profit cap', () => {
  assert.equal(capStakeToNetProfit(500000, 3, 1000000), 500000);
});

test('reduces stake at higher odds to preserve the same net-profit cap', () => {
  assert.equal(capStakeToNetProfit(5000000, 4.1, 1000000), 322580);
});

test('rejects invalid stake, odds, and cap inputs', () => {
  assert.throws(() => capStakeToNetProfit(99, 2, 10000), TypeError);
  assert.throws(() => capStakeToNetProfit(100, 1, 10000), TypeError);
  assert.throws(() => capStakeToNetProfit(100, 2, 99), TypeError);
});

test('the resulting net profit never exceeds the cap, even where floating-point division rounds up', () => {
  for (const odds of [1.07, 1.33, 1.9, 2.37, 3.15, 5.55, 11.3, 87.5]) {
    for (const cap of [100, 12_345, 1_000_000, 987_654_321]) {
      const stake = capStakeToNetProfit(100_000_000, odds, cap);
      assert.ok(Math.floor(stake * (odds - 1)) <= cap, `odds ${odds} cap ${cap} stake ${stake}`);
    }
  }
});
