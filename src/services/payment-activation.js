import { randomBytes } from 'node:crypto';
import { writeAudit } from './audit.js';
import { grantSubscription, latestExpiry, subscriptionsOf } from './subscriptions.js';

// A claim older than this is treated as a crashed attempt and may be resumed. Every step below is idempotent.
export const PROCESSING_STALE_MS = 2 * 60 * 1000;
const MAX_USER_RETRIES = 5;

export const PAYMENT_REFERENCE_PATTERN = /^betgo_[a-fA-F0-9]{24}_[a-fA-F0-9]{32}$/;

const toKobo = (value) => Math.round(Number(value) * 100);

// Returns null when a Flutterwave-verified transaction matches what BETGO asked the customer to pay, else a reason code.
// The binding is the unguessable tx_ref (set by BETGO at approval time) plus status, amount and currency.
// The payer's email is deliberately not a hard requirement: Flutterwave checkout lets customers edit it, and rejecting
// a genuine payment for that would leave a customer who has paid unactivated. It is recorded for the owner to review.
export function paymentMismatch({ verified, payment, application }) {
  if (!verified) return 'not_verified';
  if (!payment) return 'unknown_reference';
  if (!application) return 'application_missing';
  if (verified.status !== 'successful') return 'not_successful';
  if (String(verified.tx_ref) !== String(payment.reference)) return 'reference_mismatch';
  if (verified.currency !== 'NGN') return 'currency_mismatch';
  if (!Number.isFinite(toKobo(verified.amount)) || toKobo(verified.amount) !== toKobo(payment.amountNgn)) return 'amount_mismatch';
  return null;
}

function emailsDiffer(verified, application) {
  const payer = String(verified?.customer?.email || '').trim().toLowerCase();
  return Boolean(payer) && payer !== application.emailNormalized;
}

function newTemporaryPassword() { return randomBytes(18).toString('base64url'); }

async function grantToExistingUser(db, userId, payment, application, now) {
  // Optimistic concurrency: two payments for different bookmakers must not overwrite each other's grant.
  for (let attempt = 0; attempt < MAX_USER_RETRIES; attempt += 1) {
    const user = await db.collection('users').findOne({ _id: userId });
    if (!user) return null;
    if ((user.appliedPaymentRefs || []).includes(payment.reference)) return user; // this payment was already applied
    const grant = grantSubscription(user, application.bookmaker, now);
    const result = await db.collection('users').updateOne(
      { _id: user._id, subVersion: user.subVersion ?? null, appliedPaymentRefs: { $ne: payment.reference } },
      { $set: { subscriptions: grant.subscriptions, subscriptionExpiresAt: grant.subscriptionExpiresAt, bookmaker: user.bookmaker || application.bookmaker, updatedAt: now }, $addToSet: { appliedPaymentRefs: payment.reference }, $inc: { subVersion: 1 } }
    );
    if (result.matchedCount === 1) return db.collection('users').findOne({ _id: user._id });
  }
  throw new Error('Could not apply the subscription after repeated concurrent updates.');
}

// Activates exactly once per payment, whether it is reached from the webhook, the return page, or both at the same time.
// `verified` must already have been fetched from Flutterwave by transaction ID; it is never taken from request data.
export async function activateVerifiedPayment(db, { verified, hashPassword, sendEmail, appOrigin, requestId, now = new Date() }) {
  const payment = await db.collection('payments').findOne({ reference: String(verified?.tx_ref || ''), provider: 'flutterwave' });
  if (!payment) return { outcome: 'unknown_reference' };
  const application = await db.collection('applications').findOne({ _id: payment.applicationId });
  const mismatch = paymentMismatch({ verified, payment, application });
  if (mismatch) {
    await db.collection('payments').updateOne({ _id: payment._id }, { $set: { lastMismatch: mismatch, lastMismatchAt: now, updatedAt: now } });
    await writeAudit(db, { action: 'payment.mismatch', outcome: 'rejected', requestId, details: { reference: payment.reference, reason: mismatch } });
    return { outcome: 'mismatch', reason: mismatch };
  }

  if (payment.status === 'paid') return retryCredentialEmailIfNeeded(db, { payment, application, hashPassword, sendEmail, appOrigin, now });
  if (payment.status !== 'pending' && payment.status !== 'processing') return { outcome: 'not_payable', status: payment.status };

  // Atomic claim: only one caller can move pending -> processing (or resume a claim that went stale).
  const claimed = await db.collection('payments').findOneAndUpdate(
    { _id: payment._id, $or: [{ status: 'pending' }, { status: 'processing', processingAt: { $lt: new Date(now.getTime() - PROCESSING_STALE_MS) } }] },
    { $set: { status: 'processing', processingAt: now, flutterwaveTransactionId: verified.id, payerEmail: String(verified.customer?.email || '').toLowerCase() || null, payerEmailDiffers: emailsDiffer(verified, application), updatedAt: now } },
    { returnDocument: 'after' }
  );
  if (!claimed) {
    const current = await db.collection('payments').findOne({ _id: payment._id });
    return current?.status === 'paid' ? { outcome: 'already_processed' } : { outcome: 'in_progress' };
  }

  const emailNormalized = application.emailNormalized;
  let user = null;
  let createdAccount = false;
  let temporaryPassword = null;
  for (let attempt = 0; attempt < MAX_USER_RETRIES && !user; attempt += 1) {
    const existing = await db.collection('users').findOne({ emailNormalized });
    if (existing?.role === 'owner') {
      await db.collection('payments').updateOne({ _id: payment._id, status: 'processing' }, { $set: { status: 'needs_review', reviewReason: 'owner_email', updatedAt: now } });
      await writeAudit(db, { action: 'payment.needs_review', outcome: 'rejected', requestId, details: { reference: payment.reference, reason: 'owner_email' } });
      return { outcome: 'needs_review', reason: 'owner_email' };
    }
    if (existing && String(existing.applicationId || '') === String(application._id) && (existing.appliedPaymentRefs || []).includes(payment.reference)) {
      user = existing; createdAccount = true; // we created it on an earlier, interrupted attempt
      break;
    }
    if (existing) {
      user = await grantToExistingUser(db, existing._id, payment, application, now);
      createdAccount = false;
      break;
    }
    temporaryPassword = newTemporaryPassword();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    try {
      const inserted = await db.collection('users').insertOne({
        email: application.email, emailNormalized, fullName: application.fullName, passwordHash: await hashPassword(temporaryPassword), role: 'member',
        bookmaker: application.bookmaker, createdAt: now, disabledAt: null, authVersion: 1, subVersion: 1,
        subscriptionStartedAt: now, subscriptionExpiresAt: expiresAt, subscriptions: [{ bookmaker: application.bookmaker, startedAt: now, expiresAt }],
        appliedPaymentRefs: [payment.reference], mustChangePassword: true, temporaryPasswordIssuedAt: now, applicationId: application._id
      });
      user = await db.collection('users').findOne({ _id: inserted.insertedId });
      createdAccount = true;
    } catch (error) {
      if (error?.code !== 11000) throw error; // someone created the account first: loop and treat it as an existing user
    }
  }
  if (!user) throw new Error('Could not resolve the member account for this payment.');

  const bookmakerExpiresAt = subscriptionsOf(user).find((item) => item.bookmaker === application.bookmaker)?.expiresAt || latestExpiry(user);
  await db.collection('payments').updateOne({ _id: payment._id, status: 'processing' }, { $set: { status: 'paid', paidAt: now, userId: user._id, createdAccount, credentialEmailSentAt: null, updatedAt: now } });
  await db.collection('applications').updateOne({ _id: application._id, status: 'approved_awaiting_payment' }, { $set: { status: 'active', paidAt: now, subscriptionExpiresAt: bookmakerExpiresAt, userId: user._id, updatedAt: now } });
  await writeAudit(db, { action: 'payment.activate_subscription', requestId, details: { applicationId: application._id.toString(), userId: user._id.toString(), bookmaker: application.bookmaker, amountNgn: payment.amountNgn, existingAccount: !createdAccount } });

  // State is committed. Emailing is last and its failure never undoes or repeats the activation.
  const emailed = createdAccount
    ? await sendCredentials(db, { payment, application, user, temporaryPassword, bookmakerExpiresAt, hashPassword, sendEmail, appOrigin, now, requestId })
    : await sendConfirmation(db, { payment, application, bookmakerExpiresAt, sendEmail, appOrigin, requestId });
  return { outcome: 'activated', createdAccount, emailed };
}

async function sendCredentials(db, { payment, application, user, temporaryPassword, bookmakerExpiresAt, hashPassword, sendEmail, appOrigin, now, requestId }) {
  try {
    let password = temporaryPassword;
    if (!password) { // resumed attempt: the original password was never emailed, so issue a fresh one
      password = newTemporaryPassword();
      await db.collection('users').updateOne({ _id: user._id, mustChangePassword: true }, { $set: { passwordHash: await hashPassword(password), temporaryPasswordIssuedAt: now } });
    }
    await sendEmail({ to: application.email, subject: 'BETGO payment confirmed — temporary login', text: `Hello ${application.fullName},\n\nYour payment of NGN ${Number(payment.amountNgn).toLocaleString('en-NG')} is confirmed. Your ${application.bookmaker} subscription is active until ${new Date(bookmakerExpiresAt).toISOString()}.\n\nUsername: ${application.email}\nTemporary password: ${password}\n\nSign in at ${appOrigin}. Change this temporary password immediately and do not share it. Your subscription expires 30 days after payment confirmation.` });
    await db.collection('payments').updateOne({ _id: payment._id }, { $set: { credentialEmailSentAt: new Date() } });
    return true;
  } catch (error) {
    await db.collection('payments').updateOne({ _id: payment._id }, { $set: { credentialEmailError: error?.code || 'EMAIL_SEND_FAILED', credentialEmailFailedAt: new Date() } });
    await writeAudit(db, { action: 'payment.credential_email', outcome: 'failed', requestId, details: { reference: payment.reference, errorCode: error?.code || null, providerStatus: error?.providerStatus || null } });
    return false;
  }
}

async function sendConfirmation(db, { payment, application, bookmakerExpiresAt, sendEmail, appOrigin, requestId }) {
  try {
    await sendEmail({ to: application.email, subject: `BETGO ${application.bookmaker} subscription confirmed`, text: `Hello ${application.fullName},\n\nYour payment of NGN ${Number(payment.amountNgn).toLocaleString('en-NG')} is confirmed. Your ${application.bookmaker} subscription is active until ${new Date(bookmakerExpiresAt).toISOString()}.\n\nSign in at ${appOrigin} with your existing BETGO password. Your other subscriptions are unchanged.` });
    return true;
  } catch (error) {
    await writeAudit(db, { action: 'payment.confirmation_email', outcome: 'failed', requestId, details: { reference: payment.reference, errorCode: error?.code || null, providerStatus: error?.providerStatus || null } });
    return false;
  }
}

// Paid, new account, and the login email never went out: send it once. Duplicate webhooks do not rotate the password.
async function retryCredentialEmailIfNeeded(db, { payment, application, hashPassword, sendEmail, appOrigin, now }) {
  if (payment.createdAccount !== true || payment.credentialEmailSentAt) return { outcome: 'already_processed' };
  const user = await db.collection('users').findOne({ _id: payment.userId });
  if (!user || user.mustChangePassword !== true) return { outcome: 'already_processed' };
  const bookmakerExpiresAt = subscriptionsOf(user).find((item) => item.bookmaker === application.bookmaker)?.expiresAt || latestExpiry(user);
  const emailed = await sendCredentials(db, { payment, application, user, temporaryPassword: null, bookmakerExpiresAt, hashPassword, sendEmail, appOrigin, now });
  return { outcome: 'already_processed', credentialEmailRetried: true, emailed };
}
