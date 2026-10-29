import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResetLink, completePasswordReset, createResetToken, requestPasswordReset, RESET_TOKEN_TTL_MS } from '../src/services/password-reset.js';

// Minimal in-memory stand-in for the handful of collection calls the service makes.
function fakeDb(seed = {}) {
  const data = { users: [], passwordResets: [], sessions: [], auditEvents: [], ...seed };
  const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && '$gt' in cond) return value > cond.$gt;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });
  const apply = (doc, update) => {
    Object.assign(doc, update.$set || {});
    for (const [key, amount] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + amount;
  };
  return {
    data,
    collection: (name) => ({
      findOne: async (filter) => data[name].find((doc) => matches(doc, filter)) || null,
      insertOne: async (doc) => { data[name].push({ ...doc }); return { insertedId: doc._id }; },
      updateOne: async (filter, update) => { const doc = data[name].find((d) => matches(d, filter)); if (doc) apply(doc, update); return { matchedCount: doc ? 1 : 0 }; },
      updateMany: async (filter, update) => { for (const doc of data[name].filter((d) => matches(d, filter))) apply(doc, update); return {}; },
      findOneAndUpdate: async (filter, update) => { const doc = data[name].find((d) => matches(d, filter)); if (!doc) return null; apply(doc, update); return doc; }
    })
  };
}

const now = new Date('2026-10-29T10:00:00Z');
const user = { _id: 'u1', email: 'Member@Example.com', emailNormalized: 'member@example.com', authVersion: 0, mustChangePassword: true };

function mailer() { const sent = []; return { sent, sendEmail: async (message) => { sent.push(message); } }; }
const tokenFrom = (message) => message.text.match(/#reset=([\w-]+)/)[1];

test('reset link keeps the token in the fragment', () => {
  assert.equal(buildResetLink('https://betgo.onrender.com/', 'abc'), 'https://betgo.onrender.com/#reset=abc');
  const { token, tokenHash } = createResetToken();
  assert.ok(token.length >= 43);
  assert.notEqual(token, tokenHash);
});

test('unknown email sends nothing and stores nothing', async () => {
  const db = fakeDb(); const { sent, sendEmail } = mailer();
  const result = await requestPasswordReset(db, { email: 'nobody@example.com', appOrigin: 'https://x', requestId: 'r', sendEmail, now });
  assert.equal(result.sent, false); assert.equal(sent.length, 0); assert.equal(db.data.passwordResets.length, 0);
});

test('a known email gets one link, a repeat within a minute is ignored, a later one retires the first', async () => {
  const db = fakeDb({ users: [{ ...user }] }); const { sent, sendEmail } = mailer();
  assert.equal((await requestPasswordReset(db, { email: ' MEMBER@example.com ', appOrigin: 'https://x', requestId: 'r', sendEmail, now })).sent, true);
  assert.equal((await requestPasswordReset(db, { email: 'member@example.com', appOrigin: 'https://x', requestId: 'r', sendEmail, now: new Date(now.getTime() + 10_000) })).reason, 'cooldown');
  assert.equal(sent.length, 1);
  const later = new Date(now.getTime() + 5 * 60_000);
  await requestPasswordReset(db, { email: 'member@example.com', appOrigin: 'https://x', requestId: 'r', sendEmail, now: later });
  assert.equal(sent.length, 2);
  const hash = async (value) => `hashed:${value}`;
  assert.equal(await completePasswordReset(db, { token: tokenFrom(sent[0]), newPassword: 'a-new-password-1', hashPassword: hash, requestId: 'r', now: later }), null);
  assert.ok(await completePasswordReset(db, { token: tokenFrom(sent[1]), newPassword: 'a-new-password-1', hashPassword: hash, requestId: 'r', now: later }));
});

test('completing a reset sets the password, clears the temporary flag, revokes sessions and cannot be replayed', async () => {
  const db = fakeDb({ users: [{ ...user }], sessions: [{ userId: 'u1', revokedAt: null }] }); const { sent, sendEmail } = mailer();
  await requestPasswordReset(db, { email: 'member@example.com', appOrigin: 'https://x', requestId: 'r', sendEmail, now });
  const token = tokenFrom(sent[0]);
  const hash = async (value) => `hashed:${value}`;
  const result = await completePasswordReset(db, { token, newPassword: 'a-new-password-1', hashPassword: hash, requestId: 'r', now: new Date(now.getTime() + 60_000) });
  assert.ok(result);
  assert.equal(db.data.users[0].passwordHash, 'hashed:a-new-password-1');
  assert.equal(db.data.users[0].mustChangePassword, false);
  assert.equal(db.data.users[0].authVersion, 1);
  assert.ok(db.data.sessions[0].revokedAt);
  assert.equal(await completePasswordReset(db, { token, newPassword: 'another-password-2', hashPassword: hash, requestId: 'r', now: new Date(now.getTime() + 120_000) }), null);
});

test('expired and unknown tokens are rejected', async () => {
  const db = fakeDb({ users: [{ ...user }] }); const { sent, sendEmail } = mailer();
  await requestPasswordReset(db, { email: 'member@example.com', appOrigin: 'https://x', requestId: 'r', sendEmail, now });
  const hash = async (value) => value;
  assert.equal(await completePasswordReset(db, { token: tokenFrom(sent[0]), newPassword: 'a-new-password-1', hashPassword: hash, requestId: 'r', now: new Date(now.getTime() + RESET_TOKEN_TTL_MS + 1000) }), null);
  assert.equal(await completePasswordReset(db, { token: 'not-a-real-token', newPassword: 'a-new-password-1', hashPassword: hash, requestId: 'r', now }), null);
});

test('email provider failure is reported without leaking to the caller', async () => {
  const db = fakeDb({ users: [{ ...user }] });
  const result = await requestPasswordReset(db, { email: 'member@example.com', appOrigin: 'https://x', requestId: 'r', sendEmail: async () => { throw Object.assign(new Error('boom'), { code: 'EMAIL_PROVIDER_ERROR' }); }, now });
  assert.equal(result.sent, false); assert.equal(result.reason, 'email_failed');
});
