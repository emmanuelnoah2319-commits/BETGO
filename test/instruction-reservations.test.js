import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseInstructionReservation } from '../src/services/instruction-reservations.js';

function fakeDb({ spendMarker = false, policyMarker = false } = {}) {
  const spend = { releasedInstructionIds: spendMarker ? ['instruction-1'] : [], reservedStakeMinor: 5000, accountReservedStakeMinor: { account1: 5000 } };
  const policy = { releasedOpenSlotInstructionIds: policyMarker ? ['instruction-1'] : [], openInstructionCount: 1 };
  const updates = [];
  return {
    updates,
    spend,
    policy,
    collection(name) {
      return {
        async updateOne(filter, update) {
          updates.push({ name, filter, update });
          if (name === 'dailySpend') {
            if ((spend.releasedInstructionIds || []).includes('instruction-1')) return { modifiedCount: 0 };
            spend.reservedStakeMinor -= 5000;
            spend.accountReservedStakeMinor.account1 -= 5000;
            spend.releasedInstructionIds.push('instruction-1');
            return { modifiedCount: 1 };
          }
          if (name === 'safetyPolicies') {
            if ((policy.releasedOpenSlotInstructionIds || []).includes('instruction-1')) return { modifiedCount: 0 };
            policy.openInstructionCount -= 1;
            policy.releasedOpenSlotInstructionIds.push('instruction-1');
            return { modifiedCount: 1 };
          }
          return { modifiedCount: 1 };
        },
        async findOne() { return name === 'dailySpend' ? spend : policy; }
      };
    }
  };
}

const instruction = {
  _id: { toString: () => 'instruction-1' }, ownerUserId: 'owner-1',
  accountId: { toString: () => 'account1' }, reservationDay: '2026-10-28',
  stakeMinor: 5000, reservationActive: false, status: 'cancelled'
};

test('reservation release decrements exposure and open slot once', async () => {
  const db = fakeDb();
  await releaseInstructionReservation(db, instruction);
  assert.equal(db.spend.reservedStakeMinor, 0);
  assert.equal(db.spend.accountReservedStakeMinor.account1, 0);
  assert.equal(db.policy.openInstructionCount, 0);
  assert.equal(db.updates.at(-1).name, 'betInstructions');
});

test('already released markers prevent a second decrement', async () => {
  const db = fakeDb({ spendMarker: true, policyMarker: true });
  await releaseInstructionReservation(db, instruction);
  assert.equal(db.spend.reservedStakeMinor, 5000);
  assert.equal(db.policy.openInstructionCount, 1);
});
