export const CANCELLABLE_INSTRUCTION_STATUSES = Object.freeze([
  'prepared',
  'awaiting_approval',
  'approved_not_submitted'
]);

const TRANSITIONS = Object.freeze({
  approve: Object.freeze({ awaiting_approval: 'approved_not_submitted' }),
  cancel: Object.freeze({
    prepared: 'cancelled',
    awaiting_approval: 'cancelled',
    approved_not_submitted: 'cancelled'
  }),
  reject: Object.freeze({
    awaiting_approval: 'rejected',
    approved_not_submitted: 'rejected'
  })
});

export function transitionInstructionStatus(currentStatus, action) {
  return TRANSITIONS[action]?.[currentStatus] ?? null;
}

// A reviewer approval is not a bookmaker acceptance and never enables submission.
export function submissionAllowedForStatus(_status) {
  return false;
}
