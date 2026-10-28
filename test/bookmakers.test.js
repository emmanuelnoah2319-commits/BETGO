import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookmakerConnector, listBookmakerIntegrations, supportedBookmakerPlatforms } from '../src/integrations/bookmakers.js';

test('all target bookmakers fail closed with bet placement disabled', () => {
  const integrations = listBookmakerIntegrations();
  assert.deepEqual(integrations.map((item) => item.name), supportedBookmakerPlatforms);
  for (const integration of integrations) {
    assert.equal(integration.status, 'unavailable');
    assert.equal(integration.betPlacement, false);
    assert.equal(integration.automaticBettingEnabled, false);
    assert.deepEqual(integration.capabilities, []);
  }
});

test('no connector can be obtained for an unverified bookmaker', () => {
  for (const platform of supportedBookmakerPlatforms) {
    assert.throws(() => getBookmakerConnector(platform), { code: 'BOOKMAKER_CONNECTOR_UNAVAILABLE', status: 503 });
  }
});

test('unknown bookmaker is rejected', () => {
  assert.throws(() => getBookmakerConnector('ImaginaryBet'), { code: 'UNSUPPORTED_BOOKMAKER' });
});
