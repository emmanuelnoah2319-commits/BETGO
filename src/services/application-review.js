import { randomUUID } from 'node:crypto';
import { writeAudit } from './audit.js';
import { emailPreflight } from './notifications.js';

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function reviewError(status, code, message) {
  const error = new Error(message);
  error.status = status; error.code = code; error.expose = true;
  return error;
}

function paymentEmail(application, link) {
  return {
    to: application.email,
    subject: 'Your BETGO application is approved',
    text: `Hello ${application.fullName},\n\nYour application for ${application.bookmaker} has been approved.\n\nSubscription price: NGN ${application.priceNgn.toLocaleString('en-NG')} for 30 days.\n\nComplete payment securely using this Flutterwave link:\n${link}\n\nYour 30-day subscription starts only after Flutterwave confirms successful payment. Do not share your payment details with anyone.`,
    html: `<p>Hello ${escapeHtml(application.fullName)},</p><p>Your application for ${escapeHtml(application.bookmaker)} has been approved.</p><p>Subscription price: NGN ${application.priceNgn.toLocaleString('en-NG')} for 30 days.</p><p>Complete payment securely using this Flutterwave link:</p><p><a href="${escapeHtml(link)}">Pay securely with Flutterwave</a></p><p>Your 30-day subscription starts only after Flutterwave confirms successful payment. Do not share your payment details with anyone.</p>`
  };
}

async function deliver(db, sendEmail, message, { actorUserId, action, requestId, applicationId }) {
  try {
    await sendEmail(message);
    return { sent: true };
  } catch (error) {
    // Provider text goes to server logs and the audit trail only; the owner UI gets a generic, actionable message.
    console.error(JSON.stringify({ level: 'error', event: `${action}_email_failed`, requestId, applicationId, errorCode: error?.code || 'EMAIL_SEND_FAILED', providerStatus: error?.providerStatus || null, providerMessage: error?.providerMessage || null }));
    await writeAudit(db, { actorUserId, action, outcome: 'email_failed', requestId, details: { applicationId, errorCode: error?.code || null, providerStatus: error?.providerStatus || null } });
    return { sent: false, errorCode: error?.code || 'EMAIL_SEND_FAILED' };
  }
}

// Approval creates the payment record and link first, then emails it. A mail failure no longer strands the applicant:
// the application stays approved_awaiting_payment, the link is returned to the owner, and the email can be re-sent.
export async function approveApplication(db, config, { applicationId, reviewerId, requestId, initializePayment, sendEmail, now = new Date() }) {
  if (!config.flutterwaveSecretKey) throw reviewError(503, 'PAYMENTS_NOT_CONFIGURED', 'Flutterwave is not configured. Application was not changed.');
  const application = await db.collection('applications').findOne({ _id: applicationId, status: 'pending' });
  if (!application) throw reviewError(409, 'APPLICATION_NOT_PENDING', 'Application not found or already reviewed.');
  const blocked = emailPreflight(config, application.email);
  if (blocked) throw reviewError(blocked.status, blocked.code, blocked.message);

  const reference = `betgo_${application._id.toString()}_${randomUUID().replaceAll('-', '')}`;
  const payment = await initializePayment(config, {
    email: application.email, fullName: application.fullName, amountNgn: application.priceNgn, reference,
    callbackUrl: config.flutterwaveCallbackUrl,
    metadata: { applicationId: application._id.toString(), bookmaker: application.bookmaker, subscriptionDays: 30 }
  });
  // Record the payment before flipping the application, so a webhook can never arrive for an unknown reference.
  const paymentInsert = await db.collection('payments').insertOne({ applicationId: application._id, reference, amountNgn: application.priceNgn, status: 'pending', provider: 'flutterwave', createdAt: now, updatedAt: now });
  const updated = await db.collection('applications').findOneAndUpdate(
    { _id: application._id, status: 'pending' },
    { $set: { status: 'approved_awaiting_payment', reviewedAt: now, reviewedByUserId: reviewerId, paymentReference: reference, paymentUrl: payment.link, updatedAt: now } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    await db.collection('payments').updateOne({ _id: paymentInsert.insertedId, status: 'pending' }, { $set: { status: 'voided', updatedAt: new Date() } });
    throw reviewError(409, 'APPLICATION_NOT_PENDING', 'Application was reviewed concurrently.');
  }
  const mail = await deliver(db, sendEmail, paymentEmail(application, payment.link), { actorUserId: reviewerId, action: 'application.approve', requestId, applicationId: application._id.toString() });
  await db.collection('applications').updateOne({ _id: application._id }, { $set: { paymentEmailSentAt: mail.sent ? new Date() : null, paymentEmailError: mail.sent ? null : mail.errorCode } });
  await writeAudit(db, { actorUserId: reviewerId, action: 'application.approve', requestId, details: { applicationId: application._id.toString(), bookmaker: application.bookmaker, amountNgn: application.priceNgn, notificationSent: mail.sent } });
  return { paymentUrl: payment.link, notificationSent: mail.sent, amountNgn: application.priceNgn, bookmaker: application.bookmaker };
}

export async function resendPaymentEmail(db, config, { applicationId, reviewerId, requestId, sendEmail }) {
  const application = await db.collection('applications').findOne({ _id: applicationId, status: 'approved_awaiting_payment' });
  if (!application?.paymentUrl) throw reviewError(409, 'NOT_AWAITING_PAYMENT', 'This application is not waiting for payment.');
  const blocked = emailPreflight(config, application.email);
  if (blocked) throw reviewError(blocked.status, blocked.code, blocked.message);
  const mail = await deliver(db, sendEmail, paymentEmail(application, application.paymentUrl), { actorUserId: reviewerId, action: 'application.resend_payment_email', requestId, applicationId: application._id.toString() });
  await db.collection('applications').updateOne({ _id: application._id }, { $set: { paymentEmailSentAt: mail.sent ? new Date() : application.paymentEmailSentAt || null, paymentEmailError: mail.sent ? null : mail.errorCode } });
  return { notificationSent: mail.sent, paymentUrl: application.paymentUrl };
}

export async function rejectApplication(db, config, { applicationId, reviewerId, reason, requestId, sendEmail, now = new Date() }) {
  const existing = await db.collection('applications').findOne({ _id: applicationId, status: 'pending' });
  if (!existing) throw reviewError(409, 'APPLICATION_NOT_PENDING', 'Application not found or already reviewed.');
  const blocked = emailPreflight(config, existing.email);
  if (blocked) throw reviewError(blocked.status, blocked.code, blocked.message);
  const application = await db.collection('applications').findOneAndUpdate(
    { _id: applicationId, status: 'pending' },
    { $set: { status: 'rejected', rejectionReason: reason, reviewedAt: now, reviewedByUserId: reviewerId, updatedAt: now } },
    { returnDocument: 'after' }
  );
  if (!application) throw reviewError(409, 'APPLICATION_NOT_PENDING', 'Application not found or already reviewed.');
  const mail = await deliver(db, sendEmail, { to: application.email, subject: 'BETGO application update', text: `Hello ${application.fullName},\n\nYour BETGO application for ${application.bookmaker} was not approved.\n\nReason: ${reason}\n\nYou may contact BETGO support if you need clarification.` }, { actorUserId: reviewerId, action: 'application.reject', requestId, applicationId: application._id.toString() });
  await writeAudit(db, { actorUserId: reviewerId, action: 'application.reject', requestId, details: { applicationId: application._id.toString(), bookmaker: application.bookmaker, notificationSent: mail.sent } });
  return { notificationSent: mail.sent };
}
