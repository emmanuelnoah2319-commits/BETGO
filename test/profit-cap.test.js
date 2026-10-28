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
