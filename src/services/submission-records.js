import { randomUUID } from 'node:crypto';
import { transitionSubmissionStatus, validateSubmissionRecord } from './submission-lifecycle.js';

/**
 * Durable submission-record primitives. These functions never call a bookmaker.
 * They are deliberately not exposed as a public route or worker until an
 * authorized connector and provider-specific reconciliation are approved.
 */
export class SubmissionRecordError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubmissionRecordError';
    this.code = code;
  }
}

export async function createQueuedSubmission(db, { ownerUserId, instructionId, idempotencyKey }) {
  if (!ownerUserId) throw new SubmissionRecordError('OWNER_REQUIRED', 'Owner scope is required.');
  if (!instructionId) throw new SubmissionRecordError('INSTRUCTION_REQUIRED', 'Instruction ID is required.');
  const draft = { instructionId: String(instructionId), idempotencyKey, status: 'queued', attempt: 0, retryAllowed: false };
  const validation = validateSubmissionRecord(draft);
  if (!validation.valid) throw new SubmissionRecordError('INVALID_RECORD', validation.errors.join('; '));

  const instruction = await db.collection('betInstructions').findOne({
    _id: instructionId,
    ownerUserId,
    status: 'approved_not_submitted',
    reservationActive: true,
    submissionEnabled: false
  });
  if (!instruction) throw new SubmissionRecordError('INSTRUCTION_NOT_APPROVED', 'Only an owner-scoped, approved instruction with an active reservation can create a queued record.');

  const now = new Date();
  const record = {
    _id: randomUUID(),
    ownerUserId,
    instructionId: instruction._id,
    accountId: instruction.accountId,
    platform: instruction.platform,
    idempotencyKey,
    status: 'queued',
    attempt: 0,
    retryAllowed: false,
    submissionEnabled: false,
    providerReference: null,
    lastErrorCode: null,
    history: [{ from: null, to: 'queued', at: now, actor: 'system' }],
    createdAt: now,
    updatedAt: now
  };
  try {
    await db.collection('betSubmissions').insertOne(record);
    return { record, replayed: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const prior = await db.collection('betSubmissions').findOne({ ownerUserId, idempotencyKey });
    if (prior) return { record: prior, replayed: true };
    const sameInstruction = await db.collection('betSubmissions').findOne({ instructionId: instruction._id, accountId: instruction.accountId });
    if (sameInstruction) throw new SubmissionRecordError('SUBMISSION_EXISTS', 'A submission record already exists for this instruction and account.');
    throw new SubmissionRecordError('DUPLICATE_SUBMISSION', 'A unique submission constraint prevented a duplicate record.');
  }
}

/** Compare-and-set transition: only one concurrent worker can claim a state. */
export async function transitionStoredSubmission(db, { ownerUserId, submissionId, action, actor = 'system', providerReference = null, errorCode = null }) {
  if (!ownerUserId || !submissionId) throw new SubmissionRecordError('IDENTITY_REQUIRED', 'Owner and submission identity are required.');
  const collection = db.collection('betSubmissions');
  const current = await collection.findOne({ _id: submissionId, ownerUserId });
  if (!current) throw new SubmissionRecordError('NOT_FOUND', 'Submission record was not found for this owner.');
  const nextStatus = transitionSubmissionStatus(current.status, action);
  if (!nextStatus) throw new SubmissionRecordError('INVALID_TRANSITION', `Action ${action} is not allowed from ${current.status}.`);

  const now = new Date();
  const set = { status: nextStatus, updatedAt: now, retryAllowed: false };
  if (action === 'start') set.attempt = current.attempt + 1;
  if (nextStatus === 'accepted') {
    if (typeof providerReference !== 'string' || !providerReference.trim()) {
      throw new SubmissionRecordError('PROVIDER_REFERENCE_REQUIRED', 'An accepted result requires a verified provider reference.');
    }
    set.providerReference = providerReference.trim().slice(0, 200);
  }
  if (nextStatus === 'rejected' && errorCode) set.lastErrorCode = String(errorCode).slice(0, 100);
  if (action === 'recoverStale') {
    set.reconciliationRequired = true;
    set.lastErrorCode = 'WORKER_LEASE_EXPIRED';
    set.recoveredAt = now;
  }

  const result = await collection.updateOne(
    { _id: submissionId, ownerUserId, status: current.status },
    { $set: set, $push: { history: { from: current.status, to: nextStatus, action, at: now, actor: String(actor).slice(0, 80) } } }
  );
  if (result.matchedCount !== 1) throw new SubmissionRecordError('CONCURRENT_TRANSITION', 'Submission state changed concurrently; reload before proceeding.');
  return collection.findOne({ _id: submissionId, ownerUserId });
}
