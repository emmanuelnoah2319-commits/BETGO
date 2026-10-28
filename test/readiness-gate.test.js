import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConnectorReadiness, requiredConnectorEvidence } from '../src/integrations/readiness-gate.js';

function makeEvidence() {
  return Object.fromEntries(requiredConnectorEvidence.map((key) => [key, {
    verified: true,
    reference: `evidence://${key}`,
    reviewedBy: 'security-reviewer',
    reviewedAt: '2026-10-27T12:00:00.000Z'
  }]));
}

const completeAdapter = { placeBet: async () => {}, reconcileBet: async () => {} };

test('connector readiness fails closed when evidence and adapter are missing', () => {
  const result = evaluateConnectorReadiness();
  assert.equal(result.ready, false);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.missingEvidence, requiredConnectorEvidence);
  assert.deepEqual(result.missingAdapterMethods, ['placeBet', 'reconcileBet']);
  assert.equal(result.requiresExplicitEnablement, true);
});

test('bare booleans do not count as reviewable evidence', () => {
  const evidence = Object.fromEntries(requiredConnectorEvidence.map((key) => [key, true]));
  const result = evaluateConnectorReadiness({ evidence, adapter: completeAdapter, explicitlyEnabled: true });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingEvidence, requiredConnectorEvidence);
});

test('complete evidence and adapter still require explicit enablement', () => {
  const result = evaluateConnectorReadiness({ evidence: makeEvidence(), adapter: completeAdapter });
  assert.equal(result.ready, false);
  assert.equal(result.requiresExplicitEnablement, true);
  assert.deepEqual(result.missingEvidence, []);
  assert.deepEqual(result.missingAdapterMethods, []);
});

test('passing every gate only makes a connector eligible for release review', () => {
  const result = evaluateConnectorReadiness({
    evidence: makeEvidence(),
    adapter: completeAdapter,
    explicitlyEnabled: true
  });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'eligible_for_release_review');
  assert.match(result.note, /does not itself enable or execute/i);
});

test('a single missing safety check blocks readiness', () => {
  const evidence = makeEvidence();
  evidence.timeoutReconciliationVerified = { ...evidence.timeoutReconciliationVerified, verified: false };
  const result = evaluateConnectorReadiness({ evidence, adapter: completeAdapter, explicitlyEnabled: true });
  assert.deepEqual(result.missingEvidence, ['timeoutReconciliationVerified']);
});

test('an evidence record without reviewer or reference is rejected', () => {
  const evidence = makeEvidence();
  evidence.writtenAuthorization = { verified: true, reviewedBy: 'reviewer', reviewedAt: '2026-10-27T12:00:00.000Z' };
  const result = evaluateConnectorReadiness({ evidence, adapter: completeAdapter, explicitlyEnabled: true });
  assert.deepEqual(result.missingEvidence, ['writtenAuthorization']);
});

test('future-dated evidence is rejected', () => {
  const evidence = makeEvidence();
  evidence.emergencyStopVerified = { ...evidence.emergencyStopVerified, reviewedAt: '2999-01-01T00:00:00.000Z' };
  const result = evaluateConnectorReadiness({ evidence, adapter: completeAdapter, explicitlyEnabled: true });
  assert.deepEqual(result.missingEvidence, ['emergencyStopVerified']);
});

test('an adapter without reconciliation cannot pass', () => {
  const result = evaluateConnectorReadiness({
    evidence: makeEvidence(),
    adapter: { placeBet: async () => {} },
    explicitlyEnabled: true
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingAdapterMethods, ['reconcileBet']);
});
