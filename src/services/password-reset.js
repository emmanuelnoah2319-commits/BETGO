import { randomBytes } from 'node:crypto';
import { hashToken } from '../security/sessions.js';
import { writeAudit } from './audit.js';

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;

export function createResetToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

// The token travels in the URL fragment, which browsers never send to the server, so it stays out of access logs and Referer headers.
export function buildResetLink(appOrigin, token) {
  return `${String(appOrigin).replace(/\/+$/, '')}/#reset=${token}`;
}

// Always resolves without revealing whether the email belongs to an account; the caller returns the same response either way.
export async function requestPasswordReset(db, { email, appOrigin, requestId, sendEmail, now = new Date() }) {
  const emailNormalized = String(email).trim().toLowerCase();
  const user = await db.collection('users').findOne({ emailNormalized });
  if (!user) return { sent: false, reason: 'unknown_email' };
  const recent = await db.collection('passwordResets').findOne({ userId: user._id, createdAt: { $gt: new Date(now.getTime() - RESET_REQUEST_COOLDOWN_MS) } });
  if (recent) return { sent: false, reason: 'cooldown' };
  const { token, tokenHash } = createResetToken();
  // Only the newest link works: earlier unused links are retired.
  await db.collection('passwordResets').updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: now, supersededAt: now } });
  await db.collection('passwordResets').insertOne({ userId: user._id, tokenHash, createdAt: now, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS), usedAt: null, requestId });
  try {
    await sendEmail({
      to: user.email,
      subject: 'Reset your BETGO password',
      text: `Hello,\n\nWe received a request to reset your BETGO password. Open this link within 30 minutes to choose a new one:\n\n${buildResetLink(appOrigin, token)}\n\nIf you did not ask for this, ignore this email; your password has not changed.`
    });
  } catch (error) {
    await writeAudit(db, { actorUserId: user._id, action: 'auth.password_reset_request', outcome: 'email_failed', requestId, details: { errorCode: error?.code || null } });
    return { sent: false, reason: 'email_failed' };
  }
  await writeAudit(db, { actorUserId: user._id, action: 'auth.password_reset_request', requestId });
  return { sent: true };
}

// Consumes the token atomically, so one link can set one password, once.
export async function completePasswordReset(db, { token, newPassword, hashPassword, requestId, now = new Date() }) {
  const record = await db.collection('passwordResets').findOneAndUpdate(
    { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } }
  );
  if (!record) return null;
  const user = await db.collection('users').findOne({ _id: record.userId });
  if (!user) return null;
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: now }, $inc: { authVersion: 1 } }
  );
  await db.collection('sessions').updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: now } });
  await writeAudit(db, { actorUserId: user._id, action: 'auth.password_reset_complete', requestId });
  return { user };
}
