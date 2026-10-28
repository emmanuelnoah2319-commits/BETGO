import test from 'node:test';
import assert from 'node:assert/strict';
import { CANCELLABLE_INSTRUCTION_STATUSES, submissionAllowedForStatus, transitionInstructionStatus } from '../src/services/instruction-lifecycle.js';

test('review approval advances only to approved-not-submitted', () => {
  assert.equal(transitionInstructionStatus('awaiting_approval', 'approve'), 'approved_not_submitted');
  assert.equal(submissionAllowedForStatus('approved_not_submitted'), false);
});

test('invalid and repeated approvals fail closed', () => {
  assert.equal(transitionInstructionStatus('approved_not_submitted', 'approve'), null);
  assert.equal(transitionInstructionStatus('cancelled', 'approve'), null);
  assert.equal(transitionInstructionStatus('accepted', 'approve'), null);
});

test('reviewable instructions can be rejected without enabling submission', () => {
  assert.equal(transitionInstructionStatus('awaiting_approval', 'reject'), 'rejected');
  assert.equal(transitionInstructionStatus('approved_not_submitted', 'reject'), 'rejected');
  assert.equal(transitionInstructionStatus('accepted', 'reject'), null);
  assert.equal(submissionAllowedForStatus('rejected'), false);
});

test('pending and approved-not-submitted instructions can be cancelled', () => {
  for (const status of CANCELLABLE_INSTRUCTION_STATUSES) assert.equal(transitionInstructionStatus(status, 'cancel'), 'cancelled');
  assert.equal(transitionInstructionStatus('accepted', 'cancel'), null);
});
