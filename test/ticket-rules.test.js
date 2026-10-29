import test from 'node:test';
import assert from 'node:assert/strict';
import { oddsDriftBlock, oddsSourceBlock } from '../src/services/ticket-rules.js';

test('SportyBet odds are only valid for a SportyBet account', () => {
  assert.equal(oddsSourceBlock({ accountPlatform: 'SportyBet', hasProviderSelection: true }), null);
  assert.equal(oddsSourceBlock({ accountPlatform: 'BetWinner', hasProviderSelection: true }).code, 'ODDS_SOURCE_MISMATCH');
});

test('a manual instruction without a provider selection is not restricted by platform', () => {
  assert.equal(oddsSourceBlock({ accountPlatform: 'BetWinner', hasProviderSelection: false }), null);
});

test('prematch odds must match exactly; live odds may only drift upward', () => {
  assert.equal(oddsDriftBlock({ submittedOdds: 1.9, currentOdds: 1.9, live: false }), null);
  assert.equal(oddsDriftBlock({ submittedOdds: 1.9, currentOdds: 2.0, live: false }).code, 'ODDS_CHANGED');
  assert.equal(oddsDriftBlock({ submittedOdds: 1.9, currentOdds: 1.8, live: false }).code, 'ODDS_CHANGED');
  assert.equal(oddsDriftBlock({ submittedOdds: 1.9, currentOdds: 2.0, live: true }), null);
  assert.equal(oddsDriftBlock({ submittedOdds: 1.9, currentOdds: 1.8, live: true }).code, 'ODDS_CHANGED');
});
