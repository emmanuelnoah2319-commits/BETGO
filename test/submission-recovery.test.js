import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStaleSubmissions } from '../src/services/submission-recovery.js';

function fakeDb(records) {
  const matches = (doc, query) => Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$lte' in value) return doc[key] <= value.$lte;
    return doc[key] === value;
  });
  return {
    records,
    collection(name) {
      assert.equal(name, 'betSubmissions');
      return {
        find(query) {
          let docs = records.filter((record) => matches(record, query));
          return {
            sort(spec) { docs = [...docs].sort((a, b) => spec.updatedAt === 1 ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt); return this; },
            limit(count) { docs = docs.slice(0, count); return this; },
            async toArray() { return docs.map(({ _id, ownerUserId }) => ({ _id, ownerUserId })); }
          };
        },
        async findOne(query) { const found = records.find((record) => matches(record, query)); return found ? structuredClone(found) : null; },
        async updateOne(query, update) {
          const found = records.find((record) => matches(record, query));
          if (!found) return { matchedCount: 0 };
          Object.assign(found, structuredClone(update.$set));
          found.history.push(structuredClone(update.$push.history));
          return { matchedCount: 1 };
        }
      };
    }
  };
}

const now = new Date('2026-10-28T12:00:00Z');
const old = new Date(now.getTime() - 120_000);
const fresh = new Date(now.getTime() - 5_000);
function record(id, status, updatedAt) {
  return { _id: id, ownerUserId: 'owner-1', instructionId: `instruction-${id}`, accountId: 'account-1', idempotencyKey: `idempotency-${id}-000001`, status, attempt: 1, retryAllowed: false, updatedAt, history: [{ from: 'queued', to: status, at: updatedAt, actor: 'test' }] };
}

test('recovers stale submitting records to unknown and requires reconciliation', async () => {
  const db = fakeDb([record('stale', 'submitting', old), record('fresh', 'submitting', fresh)]);
  const result = await recoverStaleSubmissions(db, { olderThanMs: 60_000, now });
  assert.deepEqual({ checked: result.checked, recovered: result.recovered, raced: result.raced }, { checked: 1, recovered: 1, raced: 0 });
  assert.equal(db.records[0].status, 'unknown');
  assert.equal(db.records[0].reconciliationRequired, true);
  assert.equal(db.records[0].lastErrorCode, 'WORKER_LEASE_EXPIRED');
  assert.equal(db.records[0].history.at(-1).action, 'recoverStale');
  assert.equal(db.records[1].status, 'submitting');
});

test('does not recover queued or already-unknown records', async () => {
  const db = fakeDb([record('queued', 'queued', old), record('unknown', 'unknown', old)]);
  const result = await recoverStaleSubmissions(db, { olderThanMs: 60_000, now });
  assert.equal(result.checked, 0);
  assert.equal(db.records[0].status, 'queued');
  assert.equal(db.records[1].status, 'unknown');
});

test('rejects unsafe recovery configuration', async () => {
  const db = fakeDb([]);
  await assert.rejects(() => recoverStaleSubmissions(db, { olderThanMs: 0, now }), /olderThanMs/);
  await assert.rejects(() => recoverStaleSubmissions(db, { limit: 501, now }), /limit/);
});
