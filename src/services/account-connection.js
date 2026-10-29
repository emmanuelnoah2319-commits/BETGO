export const CONNECTION_STATES = Object.freeze(['not_connected', 'connecting', 'connected', 'needs_attention', 'disconnected']);

const TRANSITIONS = Object.freeze({
  not_connected: ['connecting', 'not_connected'],
  connecting: ['connected', 'needs_attention', 'not_connected'],
  connected: ['needs_attention', 'disconnected', 'connected'],
  needs_attention: ['connecting', 'connected', 'disconnected', 'needs_attention'],
  disconnected: ['connecting', 'disconnected']
});

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

// Builds the $set document for one account's connection change. Leaving "connected" always revokes
// the integration authorization and new-activity flag, so a lost connection can never keep an account usable.
export function connectionUpdate(account, nextStatus, { reason = null, now = new Date(), checkOutcome = null } = {}) {
  const from = account.connectionStatus || 'not_connected';
  if (!CONNECTION_STATES.includes(nextStatus) || !canTransition(from, nextStatus)) {
    const error = new Error(`Cannot move a ${from} account to ${nextStatus}.`);
    error.code = 'INVALID_CONNECTION_TRANSITION';
    throw error;
  }
  const set = { connectionStatus: nextStatus, connectionReason: reason, lastCheckedAt: now, lastCheckOutcome: checkOutcome, updatedAt: now };
  if (nextStatus !== from) set.connectionStatusChangedAt = now;
  if (nextStatus === 'connected') set.lastSuccessfulSyncAt = now;
  if (nextStatus !== 'connected') { set.integrationAuthorized = false; set.enabledForNewActivity = false; }
  if (nextStatus === 'not_connected' || nextStatus === 'disconnected') { set.capabilities = []; set.balanceMinor = null; set.currency = null; }
  return { from, to: nextStatus, set };
}

// "connected" is only ever the result of a connector's own verification, never of a user request.
// With no verified connector the account stays as it was; only the check time and outcome are recorded.
export function applyConnectorCheck(account, connector, verification, now = new Date()) {
  if (!connector || typeof connector.verifyConnection !== 'function' || !verification) {
    const from = account.connectionStatus || 'not_connected';
    return { from, to: from, set: { lastCheckedAt: now, lastCheckOutcome: 'connector_unavailable', connectionReason: 'No verified, permitted connector exists for this bookmaker yet.', updatedAt: now }, connected: false };
  }
  const ok = verification.ok === true;
  const next = ok ? 'connected' : 'needs_attention';
  const from = account.connectionStatus || 'not_connected';
  // A verification attempt always passes through "connecting" unless the account is already past it.
  const base = ['connecting', 'connected', 'needs_attention'].includes(from) ? account : { ...account, connectionStatus: 'connecting' };
  const update = connectionUpdate(base, next, { reason: ok ? null : (verification.reason || 'Verification failed.'), now, checkOutcome: ok ? 'verified' : 'failed' });
  if (ok) update.set.capabilities = Array.isArray(verification.capabilities) ? verification.capabilities : [];
  return { ...update, from, connected: ok };
}
