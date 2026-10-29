import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { createFakeDb } from '../test-support/fake-db.js';
import { login } from '../src/services/auth.js';

const config = { sessionTtlHours: 12 };
const DAY = 24 * 60 * 60 * 1000;

async function memberWith(subscriptions) {
  const db = createFakeDb({ unique: {} });
  db.seed('users', { email: 'm@example.com', emailNormalized: 'm@example.com', role: 'member', disabledAt: null, authVersion: 1, passwordHash: await argon2.hash('correct-horse-battery', { type: argon2.argon2id }), subscriptions });
  return db;
}
const creds = (password) => ({ email: 'M@Example.com', password, requestId: 'r' });

test('a member with a live 30-day subscription can sign in', async () => {
  const db = await memberWith([{ bookmaker: 'SportyBet', startedAt: new Date(), expiresAt: new Date(Date.now() + 5 * DAY) }]);
  const result = await login(db, config, creds('correct-horse-battery'));
  assert.ok(result.token);
  assert.equal(db.rows('sessions').length, 1);
});

test('once every subscription has lapsed, the right password is told why it is refused and no session is created', async () => {
  const db = await memberWith([{ bookmaker: 'SportyBet', startedAt: new Date(Date.now() - 31 * DAY), expiresAt: new Date(Date.now() - DAY) }]);
  const result = await login(db, config, creds('correct-horse-battery'));
  assert.deepEqual(result, { expired: true });
  assert.equal(db.rows('sessions').length, 0);
});

test('a wrong password never reveals whether the subscription lapsed', async () => {
  const db = await memberWith([{ bookmaker: 'SportyBet', startedAt: new Date(Date.now() - 31 * DAY), expiresAt: new Date(Date.now() - DAY) }]);
  assert.equal(await login(db, config, creds('wrong-password-here')), null);
});

test('one lapsed bookmaker does not block a member who still has another active one', async () => {
  const db = await memberWith([
    { bookmaker: 'SportyBet', startedAt: new Date(Date.now() - 31 * DAY), expiresAt: new Date(Date.now() - DAY) },
    { bookmaker: 'Football.com Nigeria', startedAt: new Date(), expiresAt: new Date(Date.now() + 20 * DAY) }
  ]);
  assert.ok((await login(db, config, creds('correct-horse-battery'))).token);
});
