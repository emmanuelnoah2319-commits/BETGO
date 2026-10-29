import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../test-support/fake-db.js';
import { backfillLegacyExpiry, legacyBackfillPlan } from '../src/services/legacy-expiry.js';
import { isActive, isSubscriptionExpired, canUseBookmaker } from '../src/services/subscriptions.js';

const now = new Date('2026-10-29T12:00:00Z');
const day = 86400000;

test('a subscription without an expiry is not active', () => {
  assert.equal(isActive({ bookmaker: 'SportyBet', expiresAt: null }, now), false);
  const legacy = { role: 'member', bookmaker: 'SportyBet', subscriptionExpiresAt: null };
  assert.equal(isSubscriptionExpired(legacy, now), true);
  assert.equal(canUseBookmaker(legacy, 'SportyBet', now), false);
  assert.equal(isSubscriptionExpired({ role: 'owner', bookmaker: 'SportyBet' }, now), false);
});

test('old legacy members get 30 days from start, but never less than the grace window', () => {
  const old = { role: 'member', bookmaker: 'SportyBet', subscriptionStartedAt: new Date('2026-01-01T00:00:00Z') };
  const plan = legacyBackfillPlan(old, now);
  assert.equal(plan.subscriptions[0].expiresAt.getTime(), now.getTime() + 7 * day);
  const recent = { role: 'member', bookmaker: 'SportyBet', subscriptionStartedAt: new Date(now.getTime() - 2 * day) };
  assert.equal(legacyBackfillPlan(recent, now).subscriptions[0].expiresAt.getTime(), now.getTime() + 28 * day);
  assert.equal(legacyBackfillPlan({ role: 'member', subscriptions: [{ bookmaker: 'MSport', expiresAt: now }] }, now), null);
  assert.equal(legacyBackfillPlan({ role: 'owner', bookmaker: 'SportyBet' }, now), null);
});

test('backfill updates only members missing an expiry and is idempotent', async () => {
  const db = createFakeDb();
  db.seed('users', { emailNormalized: 'a@x.com', role: 'member', bookmaker: 'SportyBet', createdAt: new Date('2026-01-01') });
  db.seed('users', { emailNormalized: 'b@x.com', role: 'member', subscriptions: [{ bookmaker: 'MSport', expiresAt: new Date(now.getTime() + 5 * day) }] });
  db.seed('users', { emailNormalized: 'o@x.com', role: 'owner' });
  assert.deepEqual(await backfillLegacyExpiry(db, { now }), { checked: 2, updated: 1, skipped: 0 });
  assert.deepEqual(await backfillLegacyExpiry(db, { now }), { checked: 2, updated: 0, skipped: 0 });
  const a = await db.collection('users').findOne({ emailNormalized: 'a@x.com' });
  assert.equal(isSubscriptionExpired(a, now), false);
  assert.equal(a.subVersion, 1);
});
