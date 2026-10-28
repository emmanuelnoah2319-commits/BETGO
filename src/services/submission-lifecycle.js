/**
 * Pure state-machine rules for a future authorized bookmaker submission worker.
 * This module performs no network calls and cannot submit a wager.
 * Unknown outcomes must be reconciled before any retry is considered.
 */
const TRANSITIONS = Object.freeze({
  queued: Object.freeze({ start: 'submitting', cancel: 'cancelled' }),
  submitting: Object.freeze({ accepted: 'accepted', rejected: 'rejected', timeout: 'unknown', transportError: 'unknown', recoverStale: 'unknown' }),
  unknown: Object.freeze({ reconcileAccepted: 'accepted', reconcileRejected: 'rejected' }),
  accepted: Object.freeze({}),
  rejected: Object.freeze({}),
  cancelled: Object.freeze({})
});

const TERMINAL = new Set(['accepted', 'rejected', 'cancelled']);

export function transitionSubmissionStatus(currentStatus, action) {
  return TRANSITIONS[currentStatus]?.[action] ?? null;
}

export function validateSubmissionRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return Object.freeze({ valid: false, errors: Object.freeze(['record must be an object']) });
  }
  if (typeof record.instructionId !== 'string' || !record.instructionId.trim()) errors.push('instructionId is required');
  if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.trim().length < 16) errors.push('idempotencyKey must contain at least 16 characters');
  if (!Object.hasOwn(TRANSITIONS, record.status)) errors.push('status is not recognized');
  if (record.status === 'submitting' && (!Number.isInteger(record.attempt) || record.attempt < 1)) errors.push('submitting records require a positive integer attempt');
  if (record.status === 'unknown' && record.retryAllowed === true) errors.push('unknown outcomes must be reconciled before retry');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function submissionIsTerminal(status) {
  return TERMINAL.has(status);
}

export const submissionStatuses = Object.freeze(Object.keys(TRANSITIONS));
