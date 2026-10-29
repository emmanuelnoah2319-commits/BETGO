import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../test-support/fake-db.js';
import { PROCESSING_STALE_MS, activateVerifiedPayment, paymentMismatch } from '../src/services/payment-activation.js';

const REF = `betgo_${'a'.repeat(24)}_${'b'.repeat(32)}`;
const hashPassword = async (password) => `hash:${password}`;
const NOW = new Date('2026-10-29T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function setup({ price = 5000, bookmaker = 'SportyBet', existingUser = null } = {}) {
  const db = createFakeDb();
  const application = db.seed('applications', { fullName: 'Ada Member', email: 'Ada@Example.com', emailNormalized: 'ada@example.com', bookmaker, priceNgn: price, status: 'approved_awaiting_payment' });
  const payment = db.seed('payments', { applicationId: application._id, reference: REF, amountNgn: price, status: 'pending', provider: 'flutterwave' });
  if (existingUser) db.seed('users', existingUser);
  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  const verified = { id: 987654, tx_ref: REF, status: 'successful', amount: price, currency: 'NGN', customer: { email: 'ada@example.com' } };
  const run = (overrides = {}) => activateVerifiedPayment(db, { verified, hashPassword, sendEmail, appOrigin: 'https://betgo.example', requestId: 'r1', now: NOW, ...overrides });
  return { db, application, payment, sent, verified, run, sendEmail };
}

test('mismatch checks: status, reference, currency and amount must all match; payer email is not a hard requirement', () => {
  const { verified, payment, application } = setup();
  assert.equal(paymentMismatch({ verified, payment, application }), null);
  assert.equal(paymentMismatch({ verified: { ...verified, status: 'failed' }, payment, application }), 'not_successful');
  assert.equal(paymentMismatch({ verified: { ...verified, tx_ref: 'other' }, payment, application }), 'reference_mismatch');
  assert.equal(paymentMismatch({ verified: { ...verified, currency: 'USD' }, payment, application }), 'currency_mismatch');
  assert.equal(paymentMismatch({ verified: { ...verified, amount: 4999 }, payment, application }), 'amount_mismatch');
  assert.equal(paymentMismatch({ verified: { ...verified, customer: { email: 'someone.else@example.com' } }, payment, application }), null);
  assert.equal(paymentMismatch({ verified, payment, application: null }), 'application_missing');
});

test('a paid new applicant gets one member, one 30-day subscription for the right bookmaker, and one login email', async () => {
  const { db, run, sent } = setup({ bookmaker: 'BetWinner', price: 6000 });
  const result = await run();
  assert.equal(result.outcome, 'activated');
  const [user] = db.rows('users');
  assert.equal(user.role, 'member');
  assert.equal(user.mustChangePassword, true);
  assert.deepEqual(user.subscriptions.map((s) => s.bookmaker), ['BetWinner']);
  assert.equal(new Date(user.subscriptions[0].expiresAt).getTime() - NOW.getTime(), 30 * DAY);
  assert.equal(db.rows('payments')[0].status, 'paid');
  assert.equal(db.rows('applications')[0].status, 'active');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /#reset=[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(sent[0].text, /password:/i, 'no password is ever emailed');
  assert.equal(db.rows('passwordResets').length, 1);
  assert.equal(new Date(db.rows('passwordResets')[0].expiresAt).getTime() - NOW.getTime(), 72 * 60 * 60 * 1000);
});

test('the amount charged is bound to the bookmaker price on the payment record', async () => {
  const { db, run, verified } = setup({ price: 6000, bookmaker: 'MSport' });
  const wrong = await run({ verified: { ...verified, amount: 5000 } });
  assert.deepEqual([wrong.outcome, wrong.reason], ['mismatch', 'amount_mismatch']);
  assert.equal(db.rows('users').length, 0);
  assert.equal(db.rows('payments')[0].status, 'pending');
  assert.equal((await run({ verified: { ...verified, amount: 6000 } })).outcome, 'activated');
});

test('webhook and return page racing each other activate exactly once', async () => {
  const { db, run, sent } = setup();
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.equal(results.filter((r) => r.outcome === 'activated').length, 1);
  assert.equal(db.rows('users').length, 1);
  assert.equal(db.rows('users')[0].subscriptions.length, 1);
  assert.equal(sent.length, 1);
});

test('a duplicate delivery later does not extend the subscription, rotate the password or email again', async () => {
  const { db, run, sent } = setup();
  await run();
  const before = structuredClone(db.rows('users')[0]);
  const again = await run({ now: new Date(NOW.getTime() + 5 * DAY) });
  assert.equal(again.outcome, 'already_processed');
  assert.deepEqual(db.rows('users')[0], before);
  assert.equal(sent.length, 1);
});

test('an existing member buying a second bookmaker keeps their password and other subscription', async () => {
  const start = new Date(NOW.getTime() - 5 * DAY);
  const { db, run, sent } = setup({ bookmaker: 'MSport', existingUser: { email: 'ada@example.com', emailNormalized: 'ada@example.com', role: 'member', passwordHash: 'keep-me', mustChangePassword: false, subscriptions: [{ bookmaker: 'SportyBet', startedAt: start, expiresAt: new Date(start.getTime() + 30 * DAY) }] } });
  const result = await run();
  assert.deepEqual([result.outcome, result.createdAccount], ['activated', false]);
  const user = db.rows('users')[0];
  assert.equal(user.passwordHash, 'keep-me');
  assert.deepEqual(user.subscriptions.map((s) => s.bookmaker).sort(), ['MSport', 'SportyBet']);
  assert.doesNotMatch(sent[0].text, /#reset=/);
});

test('a renewal while active extends from the current expiry, once, even if delivered twice', async () => {
  const expiresAt = new Date(NOW.getTime() + 10 * DAY);
  const { db, run } = setup({ existingUser: { email: 'ada@example.com', emailNormalized: 'ada@example.com', role: 'member', passwordHash: 'x', subscriptions: [{ bookmaker: 'SportyBet', startedAt: NOW, expiresAt }] } });
  await Promise.all([run(), run()]);
  await run();
  assert.equal(new Date(db.rows('users')[0].subscriptions[0].expiresAt).getTime(), expiresAt.getTime() + 30 * DAY);
});

test('two different bookmaker payments for one member at the same moment both land', async () => {
  const db = createFakeDb();
  db.seed('users', { email: 'ada@example.com', emailNormalized: 'ada@example.com', role: 'member', passwordHash: 'x', subscriptions: [] });
  const make = (bookmaker, ref) => {
    const application = db.seed('applications', { fullName: 'Ada', email: 'ada@example.com', emailNormalized: 'ada@example.com', bookmaker, priceNgn: 5000, status: 'approved_awaiting_payment' });
    db.seed('payments', { applicationId: application._id, reference: ref, amountNgn: 5000, status: 'pending', provider: 'flutterwave' });
    return { id: 1, tx_ref: ref, status: 'successful', amount: 5000, currency: 'NGN' };
  };
  const a = make('SportyBet', REF); const b = make('Sokabet', `betgo_${'c'.repeat(24)}_${'d'.repeat(32)}`);
  const base = { hashPassword, sendEmail: async () => {}, appOrigin: 'x', now: NOW };
  await Promise.all([activateVerifiedPayment(db, { ...base, verified: a }), activateVerifiedPayment(db, { ...base, verified: b })]);
  assert.deepEqual(db.rows('users')[0].subscriptions.map((s) => s.bookmaker).sort(), ['Sokabet', 'SportyBet']);
});

test('an unknown reference or an owner email never creates or changes an account', async () => {
  const { db, run, verified } = setup();
  assert.equal((await run({ verified: { ...verified, tx_ref: 'betgo_unknown' } })).outcome, 'unknown_reference');
  const ownerCase = setup({ existingUser: { email: 'ada@example.com', emailNormalized: 'ada@example.com', role: 'owner', passwordHash: 'x' } });
  assert.equal((await ownerCase.run()).outcome, 'needs_review');
  assert.equal(ownerCase.db.rows('users')[0].subscriptions, undefined);
  assert.equal(db.rows('users').length, 0);
});

test('if the login email fails, activation stands, the retry sends one email, and later duplicates stay quiet', async () => {
  const { db, run, sent } = setup();
  let fail = true;
  const flaky = async (message) => { if (fail) { const e = new Error('down'); e.code = 'EMAIL_PROVIDER_ERROR'; throw e; } sent.push(message); };
  const first = await run({ sendEmail: flaky });
  assert.deepEqual([first.outcome, first.emailed], ['activated', false]);
  assert.equal(db.rows('payments')[0].status, 'paid');
  fail = false;
  const retry = await run({ sendEmail: flaky });
  assert.deepEqual([retry.outcome, retry.credentialEmailRetried, retry.emailed], ['already_processed', true, true]);
  assert.equal(sent.length, 1);
  const quiet = await run({ sendEmail: flaky });
  assert.equal(quiet.credentialEmailRetried, undefined);
  assert.equal(sent.length, 1);
});

test('a claim left behind by a crashed attempt is resumed without creating a second account or subscription', async () => {
  const { db, run, application, payment, sent } = setup();
  // Simulate a crash after the member was created but before the payment was marked paid.
  db.rows('payments')[0].status = 'processing';
  db.rows('payments')[0].processingAt = new Date(NOW.getTime() - PROCESSING_STALE_MS - 1000);
  db.seed('users', { email: 'ada@example.com', emailNormalized: 'ada@example.com', role: 'member', passwordHash: 'lost', mustChangePassword: true, applicationId: application._id, appliedPaymentRefs: [payment.reference], subscriptions: [{ bookmaker: 'SportyBet', startedAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * DAY) }] });
  const result = await run();
  assert.equal(result.outcome, 'activated');
  assert.equal(db.rows('users').length, 1);
  assert.equal(db.rows('users')[0].subscriptions.length, 1);
  assert.match(sent[0].text, /#reset=/);
  assert.equal(sent.length, 1);
});

test('a fresh claim held by another request is not stolen', async () => {
  const { db, run } = setup();
  db.rows('payments')[0].status = 'processing';
  db.rows('payments')[0].processingAt = NOW;
  assert.equal((await run()).outcome, 'in_progress');
  assert.equal(db.rows('users').length, 0);
});

test('the setup link lets the new member choose a password once, and a newer link retires the older one', async () => {
  const { db, run, sent } = setup();
  await run();
  const oldLink = /#reset=([A-Za-z0-9_-]{43})/.exec(sent[0].text)[1];
  const { issueSetupLink, completePasswordReset } = await import('../src/services/password-reset.js');
  let newer;
  await issueSetupLink(db, { userId: db.rows('users')[0]._id, appOrigin: 'https://betgo.example', now: NOW, send: async (link) => { newer = /#reset=([A-Za-z0-9_-]{43})/.exec(link)[1]; } });
  const hashFn = async (p) => `hash:${p}`;
  assert.equal(await completePasswordReset(db, { token: oldLink, newPassword: 'a-long-new-password', hashPassword: hashFn, now: NOW }), null);
  const done = await completePasswordReset(db, { token: newer, newPassword: 'a-long-new-password', hashPassword: hashFn, now: NOW });
  assert.ok(done);
  assert.equal(db.rows('users')[0].mustChangePassword, false);
  assert.equal(db.rows('users')[0].passwordHash, 'hash:a-long-new-password');
  assert.equal(await completePasswordReset(db, { token: newer, newPassword: 'another-long-password', hashPassword: hashFn, now: NOW }), null);
});

test('an expired setup link is refused', async () => {
  const { db, run, sent } = setup();
  await run();
  const token = /#reset=([A-Za-z0-9_-]{43})/.exec(sent[0].text)[1];
  const { completePasswordReset } = await import('../src/services/password-reset.js');
  const late = new Date(NOW.getTime() + 73 * 60 * 60 * 1000);
  assert.equal(await completePasswordReset(db, { token, newPassword: 'a-long-new-password', hashPassword: async (p) => p, now: late }), null);
});

test('forgot-password sends nothing to a deactivated member', async () => {
  const { requestPasswordReset } = await import('../src/services/password-reset.js');
  const db = createFakeDb();
  db.seed('users', { email: 'x@y.com', emailNormalized: 'x@y.com', role: 'member', disabledAt: NOW });
  const sent = [];
  const result = await requestPasswordReset(db, { email: 'X@y.com', appOrigin: 'https://betgo.example', sendEmail: async (m) => sent.push(m), now: NOW });
  assert.deepEqual([result.sent, result.reason, sent.length], [false, 'disabled', 0]);
});
