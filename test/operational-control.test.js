import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureOperationalControl, getOperationalControl, setEmergencyStop } from '../src/services/operational-control.js';

function fakeDb(initial = null) {
  const docs = new Map(initial ? [[initial._id, structuredClone(initial)]] : []);
  return {
    docs,
    collection(name) {
      assert.equal(name, 'systemControls');
      return {
        async updateOne(filter, update, options = {}) {
          let doc = docs.get(filter._id);
          if (!doc && options.upsert) doc = { _id: filter._id, ...structuredClone(update.$setOnInsert || {}) };
          if (!doc) return { matchedCount: 0, upsertedCount: 0 };
          Object.assign(doc, structuredClone(update.$set || {}));
          if (!docs.has(filter._id)) docs.set(filter._id, doc);
          return { matchedCount: 1, upsertedCount: 0 };
        },
        async findOne(filter) {
          const doc = docs.get(filter._id);
          return doc ? structuredClone(doc) : null;
        }
      };
    }
  };
}

test('new installation starts with emergency stop enabled', async () => {
  const db = fakeDb();
  const state = await ensureOperationalControl(db);
  assert.equal(state.emergencyStop, true);
  assert.match(state.reason, /no bookmaker connector is authorized/i);
});

test('missing or malformed control fails closed', async () => {
  assert.equal((await getOperationalControl(fakeDb())).emergencyStop, true);
  const db = fakeDb({ _id: 'betgo-global', emergencyStop: 'false' });
  assert.equal((await getOperationalControl(db)).emergencyStop, true);
});

test('owner can activate emergency stop with an audit-friendly reason', async () => {
  const db = fakeDb();
  await ensureOperationalControl(db);
  const state = await setEmergencyStop(db, { enabled: true, reason: 'Incident response test', actorUserId: 'owner-1' });
  assert.equal(state.emergencyStop, true);
  assert.equal(state.reason, 'Incident response test');
  assert.equal(state.updatedBy, 'owner-1');
});

test('clearing stop requires explicit non-execution acknowledgment at route layer; service validates inputs', async () => {
  const db = fakeDb();
  await ensureOperationalControl(db);
  const state = await setEmergencyStop(db, { enabled: false, reason: 'Reviewed operations state', actorUserId: 'owner-1' });
  assert.equal(state.emergencyStop, false);
  await assert.rejects(() => setEmergencyStop(db, { enabled: false, reason: 'x', actorUserId: 'owner-1' }), /reason must contain/);
});
