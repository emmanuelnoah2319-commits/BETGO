import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueuedSubmission, transitionStoredSubmission, SubmissionRecordError } from '../src/services/submission-records.js';

function fakeDb({ instructionStatus = 'approved_not_submitted', owner = 'owner-1' } = {}) {
  const instruction = { _id: 'instruction-1', ownerUserId: owner, accountId: 'account-1', platform: 'SportyBet', status: instructionStatus, reservationActive: true, submissionEnabled: false };
  const submissions = [];
  const matches = (doc, query) => Object.entries(query).every(([key, value]) => doc[key] === value);
  return {
    submissions,
    collection(name) {
      if (name === 'betInstructions') return { findOne: async (query) => matches(instruction, query) ? { ...instruction } : null };
      if (name !== 'betSubmissions') throw new Error(`Unexpected collection ${name}`);
      return {
        insertOne: async (doc) => {
          if (submissions.some((item) => item.ownerUserId === doc.ownerUserId && item.idempotencyKey === doc.idempotencyKey)) { const e = new Error('duplicate'); e.code = 11000; throw e; }
          if (submissions.some((item) => item.instructionId === doc.instructionId && item.accountId === doc.accountId)) { const e = new Error('duplicate'); e.code = 11000; throw e; }
          submissions.push(structuredClone(doc)); return { insertedId: doc._id };
        },
        findOne: async (query) => { const found = submissions.find((doc) => matches(doc, query)); return found ? structuredClone(found) : null; },
        updateOne: async (query, update) => {
          const found = submissions.find((doc) => matches(doc, query));
          if (!found) return { matchedCount: 0 };
          Object.assign(found, structuredClone(update.$set));
          found.history.push(structuredClone(update.$push.history));
          return { matchedCount: 1 };
        }
      };
    }
  };
}
const key = 'idempotency-key-00000001';

test('creates a durable queued record only for an approved, owner-scoped instruction', async () => {
  const db = fakeDb();
  const result = await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  assert.equal(result.record.status, 'queued');
  assert.equal(result.record.submissionEnabled, false);
  assert.equal(result.record.attempt, 0);
  assert.equal(db.submissions.length, 1);
});

test('refuses records for unapproved instructions and other owners', async () => {
  await assert.rejects(() => createQueuedSubmission(fakeDb({ instructionStatus: 'awaiting_approval' }), { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key }), { code: 'INSTRUCTION_NOT_APPROVED' });
  await assert.rejects(() => createQueuedSubmission(fakeDb(), { ownerUserId: 'other-owner', instructionId: 'instruction-1', idempotencyKey: key }), { code: 'INSTRUCTION_NOT_APPROVED' });
});

test('replays the same idempotency key instead of creating another record', async () => {
  const db = fakeDb();
  await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  const replay = await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  assert.equal(replay.replayed, true);
  assert.equal(db.submissions.length, 1);
});

test('starting is an atomic compare-and-set and increments the attempt', async () => {
  const db = fakeDb();
  const { record } = await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  const started = await transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'start' });
  assert.equal(started.status, 'submitting');
  assert.equal(started.attempt, 1);
  assert.equal(started.history.length, 2);
});

test('accepted state requires a provider reference and terminal state cannot restart', async () => {
  const db = fakeDb();
  const { record } = await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  await transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'start' });
  await assert.rejects(() => transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'accepted' }), { code: 'PROVIDER_REFERENCE_REQUIRED' });
  await transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'accepted', providerReference: 'provider-ref-123' });
  await assert.rejects(() => transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'start' }), { code: 'INVALID_TRANSITION' });
});

test('unknown outcome cannot be retried without reconciliation', async () => {
  const db = fakeDb();
  const { record } = await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  await transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'start' });
  const unknown = await transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'timeout' });
  assert.equal(unknown.status, 'unknown');
  await assert.rejects(() => transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'start' }), { code: 'INVALID_TRANSITION' });
});

test('hides records from another owner and rejects unsupported transitions', async () => {
  const db = fakeDb();
  const { record } = await createQueuedSubmission(db, { ownerUserId: 'owner-1', instructionId: 'instruction-1', idempotencyKey: key });
  await assert.rejects(() => transitionStoredSubmission(db, { ownerUserId: 'other-owner', submissionId: record._id, action: 'start' }), SubmissionRecordError);
  await assert.rejects(() => transitionStoredSubmission(db, { ownerUserId: 'owner-1', submissionId: record._id, action: 'accepted' }), { code: 'INVALID_TRANSITION' });
});
