import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../test-support/fake-db.js';
import { approveApplication, rejectApplication, resendPaymentEmail } from '../src/services/application-review.js';
import { emailPreflight, emailSenderStatus, parseSenderAddress, sendEmail } from '../src/services/notifications.js';

const prices = { SportyBet: 5000, BetWinner: 6000 };
const config = { flutterwaveSecretKey: 'k', flutterwaveCallbackUrl: 'https://betgo.example/payment/return', resendApiKey: 're_x', emailFrom: 'BETGO <no-reply@betgo.example>', emailTestingRecipient: '' };

function setup(bookmaker = 'BetWinner') {
  const db = createFakeDb();
  const application = db.seed('applications', { fullName: 'Ada', email: 'ada@example.com', emailNormalized: 'ada@example.com', bookmaker, priceNgn: prices[bookmaker], status: 'pending' });
  const calls = [];
  const initializePayment = async (_config, args) => { calls.push(args); return { link: `https://checkout.flutterwave.example/${args.reference}` }; };
  const sent = [];
  const sendOk = async (message) => { sent.push(message); };
  return { db, application, calls, sent, initializePayment, sendOk, base: { applicationId: application._id, reviewerId: 'owner1', requestId: 'r1' } };
}

test('approval charges the bookmaker-specific price, stores a pending payment and emails the link', async () => {
  const { db, calls, sent, initializePayment, sendOk, base } = setup('BetWinner');
  const result = await approveApplication(db, config, { ...base, initializePayment, sendEmail: sendOk });
  assert.equal(calls[0].amountNgn, 6000);
  assert.match(calls[0].reference, /^betgo_[a-f0-9]{24}_[a-f0-9]{32}$|^betgo_id\d+_[a-f0-9]{32}$/);
  assert.equal(calls[0].callbackUrl, config.flutterwaveCallbackUrl);
  assert.equal(db.rows('applications')[0].status, 'approved_awaiting_payment');
  assert.deepEqual([db.rows('payments')[0].amountNgn, db.rows('payments')[0].status], [6000, 'pending']);
  assert.equal(result.notificationSent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /NGN 6,000/);
  assert.ok(sent[0].text.includes(result.paymentUrl));
});

test('a failed email does not strand the applicant: link is returned, state is kept, and it can be re-sent', async () => {
  const { db, initializePayment, sendOk, sent, base } = setup('SportyBet');
  const broken = async () => { const e = new Error('rejected'); e.code = 'EMAIL_PROVIDER_ERROR'; e.providerStatus = 403; e.providerMessage = 'domain not verified'; throw e; };
  const result = await approveApplication(db, config, { ...base, initializePayment, sendEmail: broken });
  assert.equal(result.notificationSent, false);
  assert.ok(result.paymentUrl);
  assert.equal(db.rows('applications')[0].status, 'approved_awaiting_payment');
  assert.equal(db.rows('applications')[0].paymentEmailError, 'EMAIL_PROVIDER_ERROR');
  const resent = await resendPaymentEmail(db, config, { applicationId: base.applicationId, reviewerId: 'owner1', requestId: 'r2', sendEmail: sendOk });
  assert.equal(resent.notificationSent, true);
  assert.equal(sent.length, 1);
  assert.equal(db.rows('payments').length, 1, 're-sending must not create a second payment');
  assert.ok(db.rows('applications')[0].paymentEmailSentAt);
});

test('approving twice, or approving a rejected application, is refused', async () => {
  const { db, initializePayment, sendOk, base } = setup();
  await approveApplication(db, config, { ...base, initializePayment, sendEmail: sendOk });
  await assert.rejects(() => approveApplication(db, config, { ...base, initializePayment, sendEmail: sendOk }), { code: 'APPLICATION_NOT_PENDING' });
  const other = setup();
  await rejectApplication(other.db, config, { ...other.base, reason: 'No', sendEmail: other.sendOk });
  await assert.rejects(() => approveApplication(other.db, config, { ...other.base, initializePayment, sendEmail: other.sendOk }), { code: 'APPLICATION_NOT_PENDING' });
});

test('approval changes nothing when payments or the email sender are not usable', async () => {
  const { db, initializePayment, sendOk, base } = setup();
  await assert.rejects(() => approveApplication(db, { ...config, flutterwaveSecretKey: '' }, { ...base, initializePayment, sendEmail: sendOk }), { code: 'PAYMENTS_NOT_CONFIGURED' });
  await assert.rejects(() => approveApplication(db, { ...config, emailFrom: 'BETGO <no-reply@example.com>' }, { ...base, initializePayment, sendEmail: sendOk }), { code: 'EMAIL_SENDER_INVALID' });
  await assert.rejects(() => approveApplication(db, { ...config, emailFrom: 'onboarding@resend.dev' }, { ...base, initializePayment, sendEmail: sendOk }), { code: 'EMAIL_TESTING_RECIPIENT_REQUIRED' });
  assert.equal(db.rows('applications')[0].status, 'pending');
  assert.equal(db.rows('payments').length, 0);
});

test('a payment-provider failure leaves the application pending with no payment record', async () => {
  const { db, sendOk, base } = setup();
  const failing = async () => { const e = new Error('init failed'); e.code = 'PAYMENT_INITIALIZATION_FAILED'; throw e; };
  await assert.rejects(() => approveApplication(db, config, { ...base, initializePayment: failing, sendEmail: sendOk }), { code: 'PAYMENT_INITIALIZATION_FAILED' });
  assert.equal(db.rows('applications')[0].status, 'pending');
  assert.equal(db.rows('payments').length, 0);
});

test('rejection stores the reason, notifies the applicant, and reports a failed notification honestly', async () => {
  const a = setup();
  const ok = await rejectApplication(a.db, config, { ...a.base, reason: 'Incomplete details', sendEmail: a.sendOk });
  assert.equal(ok.notificationSent, true);
  assert.match(a.sent[0].text, /Reason: Incomplete details/);
  assert.equal(a.db.rows('applications')[0].rejectionReason, 'Incomplete details');
  const b = setup();
  const failed = await rejectApplication(b.db, config, { ...b.base, reason: 'Nope', sendEmail: async () => { throw new Error('down'); } });
  assert.equal(failed.notificationSent, false);
  assert.equal(b.db.rows('applications')[0].status, 'rejected');
});

test('sender status: placeholder and unverified-looking senders are flagged; the testing sender only reaches its recipient', () => {
  assert.equal(parseSenderAddress('BETGO <No-Reply@BetGo.example>'), 'no-reply@betgo.example');
  assert.equal(parseSenderAddress('not an address'), null);
  assert.equal(emailSenderStatus({ resendApiKey: '', emailFrom: '' }).mode, 'unconfigured');
  assert.equal(emailSenderStatus({ resendApiKey: 'k', emailFrom: 'BETGO <no-reply@example.com>' }).ready, false);
  assert.equal(emailSenderStatus(config).mode, 'custom_domain');
  const testing = { resendApiKey: 'k', emailFrom: 'BETGO <onboarding@resend.dev>', emailTestingRecipient: 'Me@Mine.com' };
  assert.equal(emailPreflight(testing, 'me@mine.com'), null);
  assert.equal(emailPreflight(testing, 'applicant@gmail.com').code, 'EMAIL_TESTING_RECIPIENT_ONLY');
});

test('sendEmail refuses blocked sends without calling Resend and surfaces provider rejections', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 403, json: async () => ({ message: 'The domain is not verified.' }) }; };
  try {
    await assert.rejects(() => sendEmail({ ...config, emailFrom: 'a@example.com' }, { to: 'x@y.com', subject: 's', text: 't' }), { code: 'EMAIL_SENDER_INVALID' });
    assert.equal(calls, 0);
    await assert.rejects(() => sendEmail(config, { to: 'x@y.com', subject: 's', text: 't' }), (error) => error.code === 'EMAIL_PROVIDER_ERROR' && error.providerStatus === 403 && /not verified/.test(error.providerMessage));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
