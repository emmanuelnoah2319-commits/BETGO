import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../test-support/fake-db.js';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-123456';
const { default: app } = await import('../src/app.js');

const REF = `betgo_${'a'.repeat(24)}_${'b'.repeat(32)}`;
const HASH = 'whsec-test-hash';
const config = { nodeEnv: 'test', appOrigin: 'https://betgo.example', flutterwaveSecretKey: 'k', flutterwaveSecretHash: HASH, flutterwaveCallbackUrl: 'https://betgo.example/payment/return', resendApiKey: 're_x', emailFrom: 'BETGO <no-reply@betgo.example>', emailTestingRecipient: '' };

async function withServer(run) {
  const db = createFakeDb();
  const application = db.seed('applications', { fullName: 'Ada', email: 'ada@example.com', emailNormalized: 'ada@example.com', bookmaker: 'BetWinner', priceNgn: 6000, status: 'approved_awaiting_payment' });
  db.seed('payments', { applicationId: application._id, reference: REF, amountNgn: 6000, status: 'pending', provider: 'flutterwave' });
  app.locals.config = config; app.locals.db = db;
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch; const outbound = [];
  let verifyPayload = { status: 'success', data: { id: 555, tx_ref: REF, status: 'successful', amount: 6000, currency: 'NGN', customer: { email: 'ada@example.com' } } };
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return realFetch(url, options);
    outbound.push(String(url));
    if (String(url).startsWith('https://api.flutterwave.com/')) return { ok: true, json: async () => verifyPayload };
    if (String(url).startsWith('https://api.resend.com/')) return { ok: true, json: async () => ({ id: 'em_1' }) };
    throw new Error(`unexpected outbound ${url}`);
  };
  try { await run({ base, db, outbound, setVerify: (p) => { verifyPayload = p; } }); }
  finally { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); }
}

const webhookBody = JSON.stringify({ event: 'charge.completed', data: { id: 555, tx_ref: REF, status: 'successful' } });
const post = (base, body, headers = {}) => fetch(`${base}/api/payments/flutterwave/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('return page: a cancelled checkout gets a friendly 200, not a rejection', () => withServer(async ({ base, db }) => {
  const res = await fetch(`${base}/payment/return?status=cancelled&tx_ref=${REF}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Payment cancelled/);
  assert.equal(db.rows('payments')[0].status, 'pending');
}));

test('return page: a successful redirect confirms with Flutterwave and activates the member', () => withServer(async ({ base, db }) => {
  const res = await fetch(`${base}/payment/return?status=successful&tx_ref=${REF}&transaction_id=555`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Payment confirmed/);
  assert.equal(db.rows('users').length, 1);
  assert.equal(db.rows('payments')[0].status, 'paid');
  const again = await fetch(`${base}/payment/return?status=successful&tx_ref=${REF}&transaction_id=555`);
  assert.equal(again.status, 200);
  assert.equal(db.rows('users').length, 1);
}));

test('return page: a redirect without transaction_id is verified by reference', () => withServer(async ({ base, db, outbound }) => {
  const res = await fetch(`${base}/payment/return?status=completed&tx_ref=${REF}`);
  assert.equal(res.status, 200);
  assert.ok(outbound.some((url) => url.includes('verify_by_reference')));
  assert.equal(db.rows('payments')[0].status, 'paid');
}));

test('return page: garbage, unconfirmed and mismatching payments are rejected without activating', () => withServer(async ({ base, db, setVerify }) => {
  assert.equal((await fetch(`${base}/payment/return?transaction_id=1&tx_ref=nope`)).status, 400);
  assert.equal((await fetch(`${base}/payment/return?tx_ref=${REF}&transaction_id=abc`)).status, 400);
  setVerify({ status: 'success', data: { id: 555, tx_ref: REF, status: 'pending', amount: 6000, currency: 'NGN' } });
  assert.equal((await fetch(`${base}/payment/return?tx_ref=${REF}&transaction_id=555`)).status, 400);
  setVerify({ status: 'success', data: { id: 555, tx_ref: REF, status: 'successful', amount: 1, currency: 'NGN' } });
  const mismatch = await fetch(`${base}/payment/return?tx_ref=${REF}&transaction_id=555`);
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /need review/);
  assert.equal(db.rows('users').length, 0);
}));

test('webhook: rejects a missing or wrong signature before doing anything', () => withServer(async ({ base, db, outbound }) => {
  assert.equal((await post(base, webhookBody)).status, 401);
  assert.equal((await post(base, webhookBody, { 'verif-hash': 'wrong' })).status, 401);
  assert.equal(outbound.length, 0);
  assert.equal(db.rows('users').length, 0);
}));

test('webhook: ignores non-successful events and never trusts the body for amount or status', () => withServer(async ({ base, db, setVerify }) => {
  const ignored = await post(base, JSON.stringify({ event: 'charge.completed', data: { id: 555, tx_ref: REF, status: 'failed' } }), { 'verif-hash': HASH });
  assert.equal(ignored.status, 200);
  assert.equal(db.rows('users').length, 0);
  setVerify({ status: 'success', data: { id: 555, tx_ref: REF, status: 'successful', amount: 10, currency: 'NGN' } });
  const forged = await post(base, JSON.stringify({ event: 'charge.completed', data: { id: 555, tx_ref: REF, status: 'successful', amount: 6000, currency: 'NGN' } }), { 'verif-hash': HASH });
  assert.equal(forged.status, 200);
  assert.equal(db.rows('users').length, 0);
  assert.equal(db.rows('payments')[0].status, 'pending');
  assert.equal((await post(base, '{not json', { 'verif-hash': HASH })).status, 400);
}));

test('webhook: a valid delivery activates once, and Flutterwave retries are harmless', () => withServer(async ({ base, db, outbound }) => {
  const first = await post(base, webhookBody, { 'verif-hash': HASH });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).activated, true);
  const retry = await post(base, webhookBody, { 'verif-hash': HASH });
  assert.equal(retry.status, 200);
  assert.equal(db.rows('users').length, 1);
  assert.equal(outbound.filter((url) => url.startsWith('https://api.resend.com/')).length, 1);
}));
