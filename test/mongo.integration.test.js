import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureOperationalControl, getOperationalControl, setEmergencyStop } from '../src/services/operational-control.js';
import { createQueuedSubmission, transitionStoredSubmission } from '../src/services/submission-records.js';
import { recoverStaleSubmissions } from '../src/services/submission-recovery.js';

const mongoTestUri = process.env.MONGO_TEST_URI;

test('MongoDB integration: indexes, fail-closed stop, idempotency, concurrent transition and stale recovery', {
  skip: !mongoTestUri ? 'Set MONGO_TEST_URI to an isolated MongoDB test server.' : false,
  timeout: 30_000
}, async (t) => {
  const [{ MongoClient, ObjectId }, { ensureIndexes }] = await Promise.all([
    import('mongodb'),
    import('../src/db/mongo.js')
  ]);
  const client = new MongoClient(mongoTestUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 });
  const databaseName = `betgo_test_${randomUUID().replaceAll('-', '')}`;
  let db;
  try {
    await client.connect();
    db = client.db(databaseName);
    await ensureIndexes(db);

    await t.test('critical unique indexes exist', async () => {
      const submissionIndexes = await db.collection('betSubmissions').indexes();
      assert.ok(submissionIndexes.some((index) => index.unique && index.key.ownerUserId === 1 && index.key.idempotencyKey === 1));
      assert.ok(submissionIndexes.some((index) => index.unique && index.key.instructionId === 1 && index.key.accountId === 1));
    });

    await t.test('emergency stop defaults on and malformed/missing state fails closed', async () => {
      const initial = await ensureOperationalControl(db);
      assert.equal(initial.emergencyStop, true);
      await db.collection('systemControls').deleteOne({ _id: 'betgo-global' });
      assert.equal((await getOperationalControl(db)).emergencyStop, true);
      await db.collection('systemControls').insertOne({ _id: 'betgo-global', emergencyStop: 'false' });
      assert.equal((await getOperationalControl(db)).emergencyStop, true);
      await setEmergencyStop(db, { enabled: true, reason: 'Integration test safety reset', actorUserId: new ObjectId() });
      assert.equal((await getOperationalControl(db)).emergencyStop, true);
    });

    const ownerUserId = new ObjectId();
    const accountId = new ObjectId();
    const instructionId = new ObjectId();
    const idempotencyKey = randomUUID();
    await db.collection('betInstructions').insertOne({
      _id: instructionId,
      ownerUserId,
      accountId,
      platform: 'SportyBet',
      status: 'approved_not_submitted',
      reservationActive: true,
      submissionEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    let submissionId;
    await t.test('creates once and replays an idempotency key', async () => {
      const first = await createQueuedSubmission(db, { ownerUserId, instructionId, idempotencyKey });
      const second = await createQueuedSubmission(db, { ownerUserId, instructionId, idempotencyKey });
      submissionId = first.record._id;
      assert.equal(first.replayed, false);
      assert.equal(second.replayed, true);
      assert.equal(second.record._id, submissionId);
      assert.equal(await db.collection('betSubmissions').countDocuments({ ownerUserId, instructionId }), 1);
    });

    await t.test('concurrent workers cannot both claim the same queued record', async () => {
      const results = await Promise.allSettled([
        transitionStoredSubmission(db, { ownerUserId, submissionId, action: 'start', actor: 'worker-a' }),
        transitionStoredSubmission(db, { ownerUserId, submissionId, action: 'start', actor: 'worker-b' })
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      const stored = await db.collection('betSubmissions').findOne({ _id: submissionId, ownerUserId });
      assert.equal(stored.status, 'submitting');
      assert.equal(stored.attempt, 1);
      assert.equal(stored.history.filter((entry) => entry.to === 'submitting').length, 1);
    });

    await t.test('stale submitting record becomes unknown and is never retried', async () => {
      const staleAt = new Date(Date.now() - 120_000);
      await db.collection('betSubmissions').updateOne({ _id: submissionId }, { $set: { updatedAt: staleAt } });
      const result = await recoverStaleSubmissions(db, { olderThanMs: 60_000, now: new Date() });
      assert.equal(result.recovered, 1);
      const stored = await db.collection('betSubmissions').findOne({ _id: submissionId, ownerUserId });
      assert.equal(stored.status, 'unknown');
      assert.equal(stored.reconciliationRequired, true);
      await assert.rejects(
        transitionStoredSubmission(db, { ownerUserId, submissionId, action: 'start' }),
        { code: 'INVALID_TRANSITION' }
      );
    });
  } finally {
    if (db) await db.dropDatabase().catch(() => {});
    await client.close().catch(() => {});
  }
});
