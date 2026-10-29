import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationBlock, grantSubscription, isSubscriptionExpired, canUseBookmaker, subscriptionsOf, latestExpiry } from '../src/services/subscriptions.js';

const now = new Date('2026-10-28T12:00:00Z');
const day = 86400000;
const member = (subscriptions) => ({ role: 'member', subscriptions });
const sub = (bookmaker, offsetDays) => ({ bookmaker, startedAt: now, expiresAt: new Date(now.getTime() + offsetDays * day) });

test('new email may apply for any bookmaker', () => {
  assert.equal(applicationBlock({ user: null, pending: null, bookmaker: 'SportyBet', now }), null);
});

test('same email may apply for a different bookmaker while another is active or pending', () => {
  const user = member([sub('SportyBet', 10)]);
  assert.equal(applicationBlock({ user, pending: null, bookmaker: 'Football.com Nigeria', now }), null);
  assert.equal(applicationBlock({ user: null, pending: null, bookmaker: 'Football.com Nigeria', now }), null);
});

test('same bookmaker with an open application is a duplicate', () => {
  assert.equal(applicationBlock({ user: null, pending: { _id: 1 }, bookmaker: 'SportyBet', now }).code, 'APPLICATION_EXISTS');
});

test('same bookmaker while active must go through renewal', () => {
  const user = member([sub('SportyBet', 10)]);
  assert.equal(applicationBlock({ user, pending: null, bookmaker: 'SportyBet', now }).code, 'RENEWAL_REQUIRED');
});

test('same bookmaker after expiry may apply again', () => {
  const user = member([sub('SportyBet', -1), sub('Football.com Nigeria', 5)]);
  assert.equal(applicationBlock({ user, pending: null, bookmaker: 'SportyBet', now }), null);
});

test('owner email cannot apply', () => {
  assert.equal(applicationBlock({ user: { role: 'owner' }, pending: null, bookmaker: 'SportyBet', now }).code, 'ACCOUNT_EXISTS');
});

test('legacy single-bookmaker users are mapped to one subscription', () => {
  const legacy = { role: 'member', bookmaker: 'SportyBet', subscriptionExpiresAt: new Date(now.getTime() + 5 * day) };
  assert.deepEqual(subscriptionsOf(legacy).map((s) => s.bookmaker), ['SportyBet']);
  assert.equal(canUseBookmaker(legacy, 'SportyBet', now), true);
  assert.equal(canUseBookmaker(legacy, 'Football.com Nigeria', now), false);
  assert.equal(applicationBlock({ user: legacy, pending: null, bookmaker: 'SportyBet', now }).code, 'RENEWAL_REQUIRED');
});

test('member is expired only when no subscription is active', () => {
  assert.equal(isSubscriptionExpired(member([sub('SportyBet', -2), sub('Football.com Nigeria', 3)]), now), false);
  assert.equal(isSubscriptionExpired(member([sub('SportyBet', -2), sub('Football.com Nigeria', -1)]), now), true);
  assert.equal(isSubscriptionExpired({ role: 'owner' }, now), false);
  assert.equal(isSubscriptionExpired({ role: 'member' }, now), false);
});

test('granting adds a bookmaker without touching the others', () => {
  const user = member([sub('SportyBet', 10)]);
  const grant = grantSubscription(user, 'Football.com Nigeria', now);
  assert.equal(grant.subscriptions.length, 2);
  assert.equal(grant.bookmakerExpiresAt.getTime(), now.getTime() + 30 * day);
  assert.equal(grant.subscriptions[0].expiresAt.getTime(), now.getTime() + 10 * day);
  assert.equal(grant.subscriptionExpiresAt.getTime(), now.getTime() + 30 * day);
});

test('renewing while active extends from the current expiry; renewing after expiry restarts from now', () => {
  const active = grantSubscription(member([sub('SportyBet', 10)]), 'SportyBet', now);
  assert.equal(active.bookmakerExpiresAt.getTime(), now.getTime() + 40 * day);
  const expired = grantSubscription(member([sub('SportyBet', -5)]), 'SportyBet', now);
  assert.equal(expired.bookmakerExpiresAt.getTime(), now.getTime() + 30 * day);
  assert.equal(latestExpiry({ subscriptions: expired.subscriptions }).getTime(), now.getTime() + 30 * day);
});
