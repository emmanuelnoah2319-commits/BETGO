import { randomUUID } from 'node:crypto';

export async function writeAudit(db, { actorUserId = null, action, outcome = 'success', requestId, details = {} }) {
  // Callers must pass allowlisted metadata only; never store credentials, tokens or raw request bodies.
  await db.collection('auditEvents').insertOne({
    _id: randomUUID(),
    actorUserId,
    action,
    outcome,
    requestId,
    details,
    createdAt: new Date()
  });
}
