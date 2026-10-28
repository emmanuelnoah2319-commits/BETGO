const REQUIRED_EVIDENCE = Object.freeze([
  'writtenAuthorization',
  'officialPlacementDocumentation',
  'authenticationVerified',
  'sandboxPlacementVerified',
  'acceptanceRejectionVerified',
  'timeoutReconciliationVerified',
  'idempotencyVerified',
  'secretStorageVerified',
  'stakeLimitsVerified',
  'emergencyStopVerified'
]);

function hasReviewableEvidence(record) {
  if (!record || typeof record !== 'object' || record.verified !== true) return false;
  if (typeof record.reference !== 'string' || !record.reference.trim()) return false;
  if (typeof record.reviewedBy !== 'string' || !record.reviewedBy.trim()) return false;
  if (typeof record.reviewedAt !== 'string' || !record.reviewedAt.trim()) return false;
  const timestamp = Date.parse(record.reviewedAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

/**
 * Pure activation gate. Evidence must be reviewable records, not bare booleans.
 * This helper does not register or enable a connector; it only reports whether
 * required evidence and a complete adapter contract exist. Production registry
 * changes still require a separate reviewed release.
 */
export function evaluateConnectorReadiness({ evidence = {}, adapter = null, explicitlyEnabled = false } = {}) {
  const missingEvidence = REQUIRED_EVIDENCE.filter((key) => !hasReviewableEvidence(evidence[key]));
  const missingAdapterMethods = ['placeBet', 'reconcileBet'].filter(
    (method) => typeof adapter?.[method] !== 'function'
  );

  const ready = missingEvidence.length === 0 && missingAdapterMethods.length === 0 && explicitlyEnabled === true;
  return Object.freeze({
    ready,
    status: ready ? 'eligible_for_release_review' : 'blocked',
    missingEvidence,
    missingAdapterMethods,
    requiresExplicitEnablement: explicitlyEnabled !== true,
    note: ready
      ? 'All gates pass; this result does not itself enable or execute a connector.'
      : 'Connector remains disabled. Reviewable evidence, adapter methods and explicit enablement are required.'
  });
}

export const requiredConnectorEvidence = REQUIRED_EVIDENCE;
