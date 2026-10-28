import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionSubmissionStatus,
  validateSubmissionRecord,
  submissionIsTerminal
} from '../src/services/submission-lifecycle.js';

test('submission can start only from queued and requires explicit transition', () => {
  assert.equal(transitionSubmissionStatus('queued', 'start'), 'submitting');
  assert.equal(transitionSubmissionStatus('accepted', 'start'), null);
  assert.equal(transitionSubmissionStatus('missing', 'start'), null);
});

test('timeout and transport failure become unknown, never an automatic retry', () => {
  assert.equal(transitionSubmissionStatus('submitting', 'timeout'), 'unknown');
  assert.equal(transitionSubmissionStatus('submitting', 'transportError'), 'unknown');
  assert.equal(transitionSubmissionStatus('unknown', 'start'), null);
  assert.equal(transitionSubmissionStatus('unknown', 'retry'), null);
});

test('unknown submission requires reconciliation to a final provider result', () => {
  assert.equal(transitionSubmissionStatus('unknown', 'reconcileAccepted'), 'accepted');
  assert.equal(transitionSubmissionStatus('unknown', 'reconcileRejected'), 'rejected');
  assert.equal(transitionSubmissionStatus('submitting', 'reconcileAccepted'), null);
});

test('accepted, rejected and cancelled states are terminal', () => {
  for (const status of ['accepted', 'rejected', 'cancelled']) {
    assert.equal(submissionIsTerminal(status), true);
    assert.equal(transitionSubmissionStatus(status, 'start'), null);
  }
  assert.equal(submissionIsTerminal('unknown'), false);
});

test('validates submission identity and attempt metadata', () => {
  assert.equal(validateSubmissionRecord({
    instructionId: 'instruction-1', idempotencyKey: 'idempotency-key-0001', status: 'queued'
  }).valid, true);
  assert.equal(validateSubmissionRecord({
    instructionId: 'instruction-1', idempotencyKey: 'short', status: 'submitting', attempt: 0
  }).valid, false);
});

test('unknown outcome with retry enabled is invalid', () => {
  const result = validateSubmissionRecord({
    instructionId: 'instruction-1', idempotencyKey: 'idempotency-key-0001', status: 'unknown', retryAllowed: true
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /reconciled before retry/);
});
