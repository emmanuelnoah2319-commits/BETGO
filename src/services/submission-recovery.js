import { transitionStoredSubmission, SubmissionRecordError } from './submission-records.js';

/**
 * Mark abandoned `submitting` records as `unknown` so they must be reconciled.
 * This never retries a wager and never contacts a bookmaker.
 */
export async function recoverStaleSubmissions(db, {
  olderThanMs = 60_000,
  limit = 100,
  now = new Date()
} = {}) {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 1_000) {
    throw new TypeError('olderThanMs must be at least 1000 milliseconds');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError('limit must be an integer between 1 and 500');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const cutoff = new Date(now.getTime() - olderThanMs);
  const candidates = await db.collection('betSubmissions')
    .find({ status: 'submitting', updatedAt: { $lte: cutoff } }, { projection: { _id: 1, ownerUserId: 1 } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();

  let recovered = 0;
  let raced = 0;
  for (const candidate of candidates) {
    try {
      await transitionStoredSubmission(db, {
        ownerUserId: candidate.ownerUserId,
        submissionId: candidate._id,
        action: 'recoverStale',
        actor: 'recovery-worker'
      });
      recovered += 1;
    } catch (error) {
      if (error instanceof SubmissionRecordError && ['CONCURRENT_TRANSITION', 'INVALID_TRANSITION', 'NOT_FOUND'].includes(error.code)) {
        raced += 1;
        continue;
      }
      throw error;
    }
  }
  return { checked: candidates.length, recovered, raced, cutoff };
}
