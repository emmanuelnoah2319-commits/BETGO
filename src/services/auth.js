import argon2 from 'argon2';
import { ObjectId } from 'mongodb';
import { createSessionToken, hashToken } from '../security/sessions.js';
import { writeAudit } from './audit.js';

export async function bootstrapOwner(db, config) {
  if (!config.bootstrapOwnerEmail) return;
  const users = db.collection('users');
  const existing = await users.findOne({ role: 'owner' });
  if (existing) return;
  const emailNormalized = config.bootstrapOwnerEmail.trim().toLowerCase();
  const passwordHash = await argon2.hash(config.bootstrapOwnerPassword, { type: argon2.argon2id });
  await users.insertOne({
    _id: new ObjectId(),
    email: config.bootstrapOwnerEmail.trim(),
    emailNormalized,
    passwordHash,
    role: 'owner',
    createdAt: new Date(),
    disabledAt: null,
    authVersion: 1
  });
  console.info(JSON.stringify({ level: 'info', event: 'bootstrap_owner_created', email: emailNormalized }));
}

export async function login(db, config, { email, password, requestId }) {
  const emailNormalized = email.trim().toLowerCase();
  const user = await db.collection('users').findOne({ emailNormalized, disabledAt: null });
  const passwordMatches = user
    ? await argon2.verify(user.passwordHash, password).catch(() => false)
    : false;
  if (!user || !passwordMatches) {
    await writeAudit(db, { action: 'auth.login', outcome: 'rejected', requestId, details: { reason: 'invalid_credentials' } });
    return null;
  }
  const rawToken = createSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 60 * 60 * 1000);
  const result = await db.collection('sessions').insertOne({
    userId: user._id,
    tokenHash: hashToken(rawToken),
    createdAt: now,
    expiresAt,
    revokedAt: null,
    authVersion: user.authVersion
  });
  await writeAudit(db, { actorUserId: user._id, action: 'auth.login', requestId });
  return { token: rawToken, expiresAt, sessionId: result.insertedId, user: { id: user._id.toString(), email: user.email, role: user.role } };
}

export async function revokeSession(db, sessionId, actorUserId, requestId) {
  await db.collection('sessions').updateOne(
    { _id: sessionId, userId: actorUserId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  await writeAudit(db, { actorUserId, action: 'auth.logout', requestId });
}
