import test from 'node:test';
import assert from 'node:assert/strict';
import { getBookmakerConnector, listBookmakerIntegrations, supportedBookmakerPlatforms } from '../src/integrations/bookmakers.js';

test('integration dashboard is scoped to SportyBet and remains fail-closed', () => {
  const integrations = listBookmakerIntegrations();
  assert.deepEqual(integrations.map((item) => item.name), ['SportyBet']);
  for (const integration of integrations) {
    assert.equal(integration.status, 'unavailable');
    assert.equal(integration.betPlacement, false);
    assert.equal(integration.accountAuthentication, false);
    assert.equal(integration.balanceLookup, false);
    assert.equal(integration.betStatusLookup, false);
    assert.equal(integration.automaticBettingEnabled, false);
    assert.deepEqual(integration.capabilities, []);
  }
});

test('existing supported account platforms fail closed when no connector is authorized', () => {
  assert.deepEqual(supportedBookmakerPlatforms, ['SportyBet', 'Football.com Nigeria']);
  for (const platform of supportedBookmakerPlatforms) {
    assert.throws(() => getBookmakerConnector(platform), { code: 'BOOKMAKER_CONNECTOR_UNAVAILABLE', status: 503 });
  }
});

test('unknown bookmaker is rejected', () => {
  assert.throws(() => getBookmakerConnector('ImaginaryBet'), { code: 'UNSUPPORTED_BOOKMAKER' });
});
