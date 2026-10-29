import test from 'node:test';
import assert from 'node:assert/strict';
import { oddsSourceBlock } from '../src/services/ticket-rules.js';

test('SportyBet odds are only valid for a SportyBet account', () => {
  assert.equal(oddsSourceBlock({ accountPlatform: 'SportyBet', hasProviderSelection: true }), null);
  assert.equal(oddsSourceBlock({ accountPlatform: 'BetWinner', hasProviderSelection: true }).code, 'ODDS_SOURCE_MISMATCH');
});

test('a manual instruction without a provider selection is not restricted by platform', () => {
  assert.equal(oddsSourceBlock({ accountPlatform: 'BetWinner', hasProviderSelection: false }), null);
});
