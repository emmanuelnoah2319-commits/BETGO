import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConnectorCheck, canTransition, connectionUpdate } from '../src/services/account-connection.js';

const now = new Date('2026-10-29T10:00:00Z');
const account = (connectionStatus) => ({ connectionStatus, integrationAuthorized: true, enabledForNewActivity: true, capabilities: ['x'], balanceMinor: 5 });

test('invalid moves are rejected and valid ones are allowed', () => {
  assert.equal(canTransition('not_connected', 'connected'), false);
  assert.equal(canTransition('disconnected', 'connected'), false);
  assert.equal(canTransition('connecting', 'connected'), true);
  assert.throws(() => connectionUpdate(account('not_connected'), 'connected'), { code: 'INVALID_CONNECTION_TRANSITION' });
  assert.throws(() => connectionUpdate(account('connected'), 'bogus'), { code: 'INVALID_CONNECTION_TRANSITION' });
});

test('leaving connected revokes authorization and activity, and disconnecting clears synced data', () => {
  const lost = connectionUpdate(account('connected'), 'needs_attention', { reason: 'Login expired', now });
  assert.equal(lost.set.integrationAuthorized, false);
  assert.equal(lost.set.enabledForNewActivity, false);
  assert.equal(lost.set.capabilities, undefined);
  const off = connectionUpdate(account('connected'), 'disconnected', { now });
  assert.deepEqual(off.set.capabilities, []);
  assert.equal(off.set.balanceMinor, null);
});

test('without a verified connector a check never changes status or claims connected', () => {
  for (const status of ['not_connected', 'needs_attention', 'disconnected']) {
    const result = applyConnectorCheck(account(status), null, null, now);
    assert.equal(result.to, status);
    assert.equal(result.connected, false);
    assert.equal(result.set.connectionStatus, undefined);
    assert.equal(result.set.lastCheckOutcome, 'connector_unavailable');
  }
  const noMethod = applyConnectorCheck(account('not_connected'), {}, { ok: true }, now);
  assert.equal(noMethod.connected, false);
});

test('a connector verification can connect from not_connected via connecting, and failures need attention', () => {
  const connector = { verifyConnection() {} };
  const ok = applyConnectorCheck({ connectionStatus: 'not_connected' }, connector, { ok: true, capabilities: ['balance'] }, now);
  assert.equal(ok.set.connectionStatus, 'connected');
  assert.deepEqual(ok.set.capabilities, ['balance']);
  assert.equal(ok.connected, true);
  const bad = applyConnectorCheck({ connectionStatus: 'connected' }, connector, { ok: false, reason: 'Session expired' }, now);
  assert.equal(bad.set.connectionStatus, 'needs_attention');
  assert.equal(bad.set.integrationAuthorized, false);
  assert.equal(bad.set.connectionReason, 'Session expired');
});
